#!/bin/bash

# Initialize MongoDB user for whatsapp_saas database
# This script runs when the MongoDB container starts for the first time

mongosh <<EOF
use whatsapp_saas

db.createUser({
  user: 'app_user',
  pwd: 'app_password',
  roles: [
    {
      role: 'readWrite',
      db: 'whatsapp_saas'
    }
  ]
})

print('User app_user created for whatsapp_saas database')
EOF
