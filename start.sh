#!/usr/bin/env sh
# doodleboard - start the local server and open it
cd "$(dirname "$0")"
exec python3 server.py --app "$@"
