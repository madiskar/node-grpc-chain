// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var test_pb = require('./test_pb.js');

function serialize_test_TestMessage(arg) {
  if (!(arg instanceof test_pb.TestMessage)) {
    throw new Error('Expected argument of type test.TestMessage');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_test_TestMessage(buffer_arg) {
  return test_pb.TestMessage.deserializeBinary(new Uint8Array(buffer_arg));
}


var TestServiceService = exports.TestServiceService = {
  rpcTest: {
    path: '/test.TestService/RpcTest',
    requestStream: false,
    responseStream: false,
    requestType: test_pb.TestMessage,
    responseType: test_pb.TestMessage,
    requestSerialize: serialize_test_TestMessage,
    requestDeserialize: deserialize_test_TestMessage,
    responseSerialize: serialize_test_TestMessage,
    responseDeserialize: deserialize_test_TestMessage,
  },
  serverStreamTest: {
    path: '/test.TestService/ServerStreamTest',
    requestStream: false,
    responseStream: true,
    requestType: test_pb.TestMessage,
    responseType: test_pb.TestMessage,
    requestSerialize: serialize_test_TestMessage,
    requestDeserialize: deserialize_test_TestMessage,
    responseSerialize: serialize_test_TestMessage,
    responseDeserialize: deserialize_test_TestMessage,
  },
  clientStreamTest: {
    path: '/test.TestService/ClientStreamTest',
    requestStream: true,
    responseStream: false,
    requestType: test_pb.TestMessage,
    responseType: test_pb.TestMessage,
    requestSerialize: serialize_test_TestMessage,
    requestDeserialize: deserialize_test_TestMessage,
    responseSerialize: serialize_test_TestMessage,
    responseDeserialize: deserialize_test_TestMessage,
  },
  biDirStreamTest: {
    path: '/test.TestService/BiDirStreamTest',
    requestStream: true,
    responseStream: true,
    requestType: test_pb.TestMessage,
    responseType: test_pb.TestMessage,
    requestSerialize: serialize_test_TestMessage,
    requestDeserialize: deserialize_test_TestMessage,
    responseSerialize: serialize_test_TestMessage,
    responseDeserialize: deserialize_test_TestMessage,
  },
};

exports.TestServiceClient = grpc.makeGenericClientConstructor(TestServiceService);
