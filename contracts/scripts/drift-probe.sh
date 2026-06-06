#!/bin/bash
# Sample latest block.timestamp vs wall clock every 15s for 5 minutes
RPC=http://127.0.0.1:8545
N=20
INTERVAL=15

printf "%-3s | %-19s | %-19s | %-6s | %-8s\n" "##" "wall_clock(UTC)" "block.timestamp(UTC)" "block#" "drift(s)"
printf -- "----+---------------------+---------------------+--------+----------\n"

for i in $(seq 1 $N); do
  wall=$(date -u +%s)
  resp=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' \
    $RPC)
  ts_hex=$(echo "$resp" | grep -oP '"timestamp":"\K[^"]+')
  num_hex=$(echo "$resp" | grep -oP '"number":"\K[^"]+')
  ts=$((16#${ts_hex#0x}))
  num=$((16#${num_hex#0x}))
  drift=$((wall - ts))
  printf "%-3d | %-19s | %-19s | %-6d | %+d\n" \
    "$i" \
    "$(date -u -d @$wall '+%F %T')" \
    "$(date -u -d @$ts   '+%F %T')" \
    "$num" "$drift"
  if [ "$i" -lt "$N" ]; then sleep $INTERVAL; fi
done
