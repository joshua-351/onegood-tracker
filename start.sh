#!/bin/bash
# Start delivery-tracker server
cd /home/ubuntu/.openclaw/delivery-tracker/packages/server
pnpm start >> /home/ubuntu/.openclaw/delivery-tracker/server.log 2>&1
