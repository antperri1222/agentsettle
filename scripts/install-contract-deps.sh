#!/bin/sh
# Installs pinned, reviewed Solidity dependencies into contracts/lib (gitignored).
set -eu
cd "$(dirname "$0")/../contracts"
mkdir -p lib
[ -d lib/openzeppelin-contracts ] || git clone -q --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
[ -d lib/forge-std ] || git clone -q --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std lib/forge-std
echo "OpenZeppelin $(git -C lib/openzeppelin-contracts describe --tags) · forge-std $(git -C lib/forge-std describe --tags)"
