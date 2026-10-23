#!/bin/sh
# Falsa app de escritorio: «abre» la conversación del enlace codex://threads/ID dejando una marca.
touch "$CODEX_HOME/opened-${2##*/}"
