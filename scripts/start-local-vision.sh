#!/bin/bash

# Configuration
PORT=8080
HOST=127.0.0.1
MODEL="models/Qwen3VL-8B-Instruct-Q4_K_M.gguf"
MM_PROJ="models/mmproj-Qwen3VL-8B-Instruct-F16.gguf"

# Check if model files exist
if [ ! -f "$MODEL" ]; then
    echo "Error: Model file $MODEL not found."
    exit 1
fi

if [ ! -f "$MM_PROJ" ]; then
    echo "Error: mmproj file $MM_PROJ not found."
    exit 1
fi

echo "Starting local vision server (Qwen3-VL via llama-server)..."
echo "URL: http://$HOST:$PORT"

# Optimized for Mac M3 Max:
# -c 8192: Limit context size to prevent OOM
# -t: Use all available CPU cores
THREADS=$(sysctl -n hw.ncpu)

llama-server \
    -m "$MODEL" \
    --mmproj "$MM_PROJ" \
    --port "$PORT" \
    --host "$HOST" \
    -c 32768 \
    -t "$THREADS" \
    --no-warmup
