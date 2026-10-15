#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' x ;;
  *) printf '%s\n' "$BRAID_CLONE_TOKEN" ;;
esac
