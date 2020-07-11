#!/bin/bash

# -------------------------------------------------------------
# Generates .js and .d.ts files from .proto definitions and
# stores them in modules/gen/*
# -------------------------------------------------------------

PROTOC_GEN_TS_PATH="../../node_modules/.bin/protoc-gen-ts"
GRPC_TOOLS_NODE_PROTOC_PLUGIN="../../node_modules/.bin/grpc_tools_node_protoc_plugin"
GRPC_TOOLS_NODE_PROTOC="../../node_modules/.bin/grpc_tools_node_protoc"
OUT_DIR="."
PROTO_DIR="."

mkdir -p $OUT_DIR
rm -f $OUT_DIR/*pb*

for f in $PROTO_DIR/*.proto; do

    # Generate Javascript code
    ${GRPC_TOOLS_NODE_PROTOC} \
        -I "${PROTO_DIR}" \
        --js_out="import_style=commonjs,binary:${OUT_DIR}" \
        --grpc_out="grpc_js:${OUT_DIR}" \
        --plugin=protoc-gen-grpc="${GRPC_TOOLS_NODE_PROTOC_PLUGIN}" \
        "${f}"

    # Generate Typescript declarations
    ${GRPC_TOOLS_NODE_PROTOC} \
        -I "${PROTO_DIR}" \
        --ts_out="generate_package_definition:${OUT_DIR}" \
        --plugin=protoc-gen-ts="${PROTOC_GEN_TS_PATH}" \
        "${f}"

done
