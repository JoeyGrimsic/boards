#!/usr/bin/env sh
# doodleboard - get the latest version (your boards are never touched)
cd "$(dirname "$0")" && git pull --ff-only && echo "Done. Restart doodleboard to use the new version."
