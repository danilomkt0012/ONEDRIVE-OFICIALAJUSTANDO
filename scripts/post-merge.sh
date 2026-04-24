#!/bin/bash
set -e

NODE_BIN="/nix/store/nvf9kaarb9kqqdbygl9cbzhli1y8yjik-nodejs-22.20.0/bin"
NODE="$NODE_BIN/node"
NPM_CLI="$NODE_BIN/../lib/node_modules/npm/bin/npm-cli.js"

"$NODE" "$NPM_CLI" install
"$NODE" ./node_modules/.bin/drizzle-kit push

