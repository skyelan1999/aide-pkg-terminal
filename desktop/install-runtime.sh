#!/bin/sh
# Explicit administrator action. No plugin auto-install or auto-download.
set -eu
if [ "$(id -u)" != 0 ]; then
  echo 'Run as the Linux runtime administrator, or use desktop/Dockerfile.runtime.' >&2
  exit 1
fi
apt-get update
apt-get install -y --no-install-recommends xvfb freerdp2-x11 tigervnc-viewer tigervnc-tools xdotool ffmpeg fonts-dejavu-core
