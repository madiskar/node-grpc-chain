// package: test
// file: test.proto

/* tslint:disable */
/* eslint-disable */

import * as grpc from "@grpc/grpc-js";
import {handleClientStreamingCall} from "@grpc/grpc-js/build/src/server-call";
import * as test_pb from "./test_pb";

interface ITestServiceService extends grpc.ServiceDefinition<grpc.UntypedServiceImplementation> {
    rpcTest: ITestServiceService_IRpcTest;
    serverStreamTest: ITestServiceService_IServerStreamTest;
    clientStreamTest: ITestServiceService_IClientStreamTest;
    biDirStreamTest: ITestServiceService_IBiDirStreamTest;
}

interface ITestServiceService_IRpcTest extends grpc.MethodDefinition<test_pb.TestMessage, test_pb.TestMessage> {
    path: string; // "/test.TestService/RpcTest"
    requestStream: false;
    responseStream: false;
    requestSerialize: grpc.serialize<test_pb.TestMessage>;
    requestDeserialize: grpc.deserialize<test_pb.TestMessage>;
    responseSerialize: grpc.serialize<test_pb.TestMessage>;
    responseDeserialize: grpc.deserialize<test_pb.TestMessage>;
}
interface ITestServiceService_IServerStreamTest extends grpc.MethodDefinition<test_pb.TestMessage, test_pb.TestMessage> {
    path: string; // "/test.TestService/ServerStreamTest"
    requestStream: false;
    responseStream: true;
    requestSerialize: grpc.serialize<test_pb.TestMessage>;
    requestDeserialize: grpc.deserialize<test_pb.TestMessage>;
    responseSerialize: grpc.serialize<test_pb.TestMessage>;
    responseDeserialize: grpc.deserialize<test_pb.TestMessage>;
}
interface ITestServiceService_IClientStreamTest extends grpc.MethodDefinition<test_pb.TestMessage, test_pb.TestMessage> {
    path: string; // "/test.TestService/ClientStreamTest"
    requestStream: true;
    responseStream: false;
    requestSerialize: grpc.serialize<test_pb.TestMessage>;
    requestDeserialize: grpc.deserialize<test_pb.TestMessage>;
    responseSerialize: grpc.serialize<test_pb.TestMessage>;
    responseDeserialize: grpc.deserialize<test_pb.TestMessage>;
}
interface ITestServiceService_IBiDirStreamTest extends grpc.MethodDefinition<test_pb.TestMessage, test_pb.TestMessage> {
    path: string; // "/test.TestService/BiDirStreamTest"
    requestStream: true;
    responseStream: true;
    requestSerialize: grpc.serialize<test_pb.TestMessage>;
    requestDeserialize: grpc.deserialize<test_pb.TestMessage>;
    responseSerialize: grpc.serialize<test_pb.TestMessage>;
    responseDeserialize: grpc.deserialize<test_pb.TestMessage>;
}

export const TestServiceService: ITestServiceService;

export interface ITestServiceServer {
    rpcTest: grpc.handleUnaryCall<test_pb.TestMessage, test_pb.TestMessage>;
    serverStreamTest: grpc.handleServerStreamingCall<test_pb.TestMessage, test_pb.TestMessage>;
    clientStreamTest: handleClientStreamingCall<test_pb.TestMessage, test_pb.TestMessage>;
    biDirStreamTest: grpc.handleBidiStreamingCall<test_pb.TestMessage, test_pb.TestMessage>;
}

export interface ITestServiceClient {
    rpcTest(request: test_pb.TestMessage, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientUnaryCall;
    rpcTest(request: test_pb.TestMessage, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientUnaryCall;
    rpcTest(request: test_pb.TestMessage, metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientUnaryCall;
    serverStreamTest(request: test_pb.TestMessage, options?: Partial<grpc.CallOptions>): grpc.ClientReadableStream<test_pb.TestMessage>;
    serverStreamTest(request: test_pb.TestMessage, metadata?: grpc.Metadata, options?: Partial<grpc.CallOptions>): grpc.ClientReadableStream<test_pb.TestMessage>;
    clientStreamTest(callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    clientStreamTest(metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    clientStreamTest(options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    clientStreamTest(metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    biDirStreamTest(): grpc.ClientDuplexStream<test_pb.TestMessage, test_pb.TestMessage>;
    biDirStreamTest(options: Partial<grpc.CallOptions>): grpc.ClientDuplexStream<test_pb.TestMessage, test_pb.TestMessage>;
    biDirStreamTest(metadata: grpc.Metadata, options?: Partial<grpc.CallOptions>): grpc.ClientDuplexStream<test_pb.TestMessage, test_pb.TestMessage>;
}

export class TestServiceClient extends grpc.Client implements ITestServiceClient {
    constructor(address: string, credentials: grpc.ChannelCredentials, options?: object);
    public rpcTest(request: test_pb.TestMessage, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientUnaryCall;
    public rpcTest(request: test_pb.TestMessage, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientUnaryCall;
    public rpcTest(request: test_pb.TestMessage, metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientUnaryCall;
    public serverStreamTest(request: test_pb.TestMessage, options?: Partial<grpc.CallOptions>): grpc.ClientReadableStream<test_pb.TestMessage>;
    public serverStreamTest(request: test_pb.TestMessage, metadata?: grpc.Metadata, options?: Partial<grpc.CallOptions>): grpc.ClientReadableStream<test_pb.TestMessage>;
    public clientStreamTest(callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    public clientStreamTest(metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    public clientStreamTest(options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    public clientStreamTest(metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: test_pb.TestMessage) => void): grpc.ClientWritableStream<test_pb.TestMessage>;
    public biDirStreamTest(options?: Partial<grpc.CallOptions>): grpc.ClientDuplexStream<test_pb.TestMessage, test_pb.TestMessage>;
    public biDirStreamTest(metadata?: grpc.Metadata, options?: Partial<grpc.CallOptions>): grpc.ClientDuplexStream<test_pb.TestMessage, test_pb.TestMessage>;
}
