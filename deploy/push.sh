#!/bin/sh
# Build the Linux relay and swap it in on a server already set up as in
# the README.
#
#   VM_HOST=root@relay.example.com [SSH_KEY=~/.ssh/key] sh deploy/push.sh
#
# The restart drops every connection. Nodes reconnect on their own, but a
# session in progress can lose a message and end, so push between sessions.

set -eu

: "${VM_HOST:?set VM_HOST, e.g. root@relay.example.com}"

SSH_OPTS="${SSH_KEY:+-i $SSH_KEY}"

cd "$(dirname "$0")/.."
bun run build:linux
scp $SSH_OPTS dist/parley-linux-x64 "$VM_HOST:/opt/parley/parley.new"
ssh $SSH_OPTS "$VM_HOST" '
  chmod 755 /opt/parley/parley.new
  mv /opt/parley/parley.new /opt/parley/parley
  systemctl restart parley-relay
  sleep 1
  systemctl is-active parley-relay
'
