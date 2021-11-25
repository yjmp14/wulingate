#!/usr/bin/env bash
[[ ! -d qrcode-svg ]] && git clone https://github.com/papnkukn/qrcode-svg.git
cp qrcode-svg/dist/qrcode.min.js client/scripts/qrcode.js
