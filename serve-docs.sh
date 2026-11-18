#!/bin/bash
# ShadowSurf 设计站点静态服务器（内部 7800）
cd /home/Developer/ShadowSurf/docs || exit 1
exec /usr/bin/python3 -m http.server 7800 --bind 127.0.0.1
