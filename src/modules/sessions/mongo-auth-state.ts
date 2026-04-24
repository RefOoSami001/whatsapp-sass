import { Mutex } from 'async-mutex';
import { proto } from '@whiskeysockets/baileys';
import {
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import type { Types } from 'mongoose';
import { WaAuthKeyModel, WaAuthStateModel } from './wa-auth-state.model.js';
import { logger } from '../../common/logger.js';

const KEY_TYPES = [
  'app-state-sync-key',
  'app-state-sync-version',
  'sender-key-memory',
  'sender-key',
  'pre-key',
  'session',
] as const;

function parseKeyFile(file: string): { keyType: string; keyId: string } | null {
  const raw = file.replace(/\.json$/i, '');
  for (const t of KEY_TYPES) {
    const p = `${t}-`;
    if (raw.startsWith(p)) {
      return { keyType: t, keyId: raw.slice(p.length) };
    }
  }
  return null;
}

function fixFileName(file: string) {
  return file?.replace(/\//g, '__')?.replace(/:/g, '-') ?? file;
}

const credsMutexes = new Map<string, Mutex>();
const keyMutexes = new Map<string, Mutex>();

function credsLock(sessionKey: string) {
  let m = credsMutexes.get(sessionKey);
  if (!m) {
    m = new Mutex();
    credsMutexes.set(sessionKey, m);
  }
  return m;
}

function keyPathLock(sessionKey: string, pathKey: string) {
  const id = `${sessionKey}:${pathKey}`;
  let m = keyMutexes.get(id);
  if (!m) {
    m = new Mutex();
    keyMutexes.set(id, m);
  }
  return m;
}

export async function useMongoAuthState(sessionMongoId: Types.ObjectId): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const sk = sessionMongoId.toString();

  const writeData = async (data: unknown, file: string) => {
    const name = fixFileName(file);
    if (name === 'creds.json') {
      await credsLock(sk).runExclusive(async () => {
        await WaAuthStateModel.findOneAndUpdate(
          { sessionId: sessionMongoId },
          { credsJson: JSON.stringify(data, BufferJSON.replacer) },
          { upsert: true }
        );
      });
      return;
    }
    const parsed = parseKeyFile(name);
    if (!parsed) {
      logger.warn({ file: name }, 'Unknown WA key file pattern');
      return;
    }
    await keyPathLock(sk, name).runExclusive(async () => {
      await WaAuthKeyModel.findOneAndUpdate(
        { sessionId: sessionMongoId, keyType: parsed.keyType, keyId: parsed.keyId },
        { valueJson: JSON.stringify(data, BufferJSON.replacer) },
        { upsert: true }
      );
    });
  };

  const readData = async (file: string) => {
    const name = fixFileName(file);
    if (name === 'creds.json') {
      return credsLock(sk).runExclusive(async () => {
        const doc = await WaAuthStateModel.findOne({ sessionId: sessionMongoId });
        if (!doc?.credsJson) return null;
        return JSON.parse(doc.credsJson, BufferJSON.reviver);
      });
    }
    const parsed = parseKeyFile(name);
    if (!parsed) return null;
    return keyPathLock(sk, name).runExclusive(async () => {
      const doc = await WaAuthKeyModel.findOne({
        sessionId: sessionMongoId,
        keyType: parsed.keyType,
        keyId: parsed.keyId,
      });
      if (!doc) return null;
      let value = JSON.parse(doc.valueJson, BufferJSON.reviver);
      if (parsed.keyType === 'app-state-sync-key' && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      return value;
    });
  };

  const removeData = async (file: string) => {
    const name = fixFileName(file);
    if (name === 'creds.json') return;
    const parsed = parseKeyFile(name);
    if (!parsed) return;
    await keyPathLock(sk, name).runExclusive(async () => {
      await WaAuthKeyModel.deleteOne({
        sessionId: sessionMongoId,
        keyType: parsed.keyType,
        keyId: parsed.keyId,
      });
    });
  };

  const credsDoc = await WaAuthStateModel.findOne({ sessionId: sessionMongoId });
  const creds: AuthenticationCreds =
    credsDoc?.credsJson && credsDoc.credsJson !== '{}'
      ? JSON.parse(credsDoc.credsJson, BufferJSON.reviver)
      : initAuthCreds();

  const keys = makeCacheableSignalKeyStore(
    {
      get: async (type, ids) => {
        const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const file = `${type}-${id}.json`;
            let value = await readData(file);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          })
        );
        return data;
      },
      set: async (d: SignalDataSet) => {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(d) as (keyof SignalDataSet)[]) {
          const bucket = d[category];
          if (!bucket) continue;
          for (const id of Object.keys(bucket)) {
            const value = bucket[id];
            const file = `${category}-${id}.json`;
            tasks.push(value ? writeData(value, file) : removeData(file));
          }
        }
        await Promise.all(tasks);
      },
    },
    logger.child({ module: 'wa-keys' })
  );

  const saveCreds = async () => {
    await credsLock(sk).runExclusive(async () => {
      await WaAuthStateModel.findOneAndUpdate(
        { sessionId: sessionMongoId },
        { credsJson: JSON.stringify(creds, BufferJSON.replacer) },
        { upsert: true }
      );
    });
  };

  return {
    state: { creds, keys },
    saveCreds,
  };
}

export async function deleteMongoAuthState(sessionMongoId: Types.ObjectId): Promise<void> {
  await WaAuthKeyModel.deleteMany({ sessionId: sessionMongoId });
  await WaAuthStateModel.deleteMany({ sessionId: sessionMongoId });
}

/** True if Baileys creds in Mongo indicate a completed login (safe to auto-resume without QR). */
export async function sessionHasPersistedLogin(sessionMongoId: Types.ObjectId): Promise<boolean> {
  const doc = await WaAuthStateModel.findOne({ sessionId: sessionMongoId }).lean();
  if (!doc?.credsJson) return false;
  try {
    const c = JSON.parse(doc.credsJson) as { me?: { id?: string } };
    return Boolean(c.me?.id);
  } catch {
    return false;
  }
}
