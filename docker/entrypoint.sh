#!/bin/sh
export TS_NODE_TRANSPILE_ONLY=true
export TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}'

npx prisma db push
npx prisma db seed
npm run start