import grpc, { ServerWritableStream, handleUnaryCall } from 'grpc';
import { TestServiceService as TestService, ITestServiceServer } from '../gen/test_grpc_pb';
import { TestMessage, AnotherTestMessage } from '../gen/test_pb';
import { initChain, Context, ServerReadableStreamRx, ServerDuplexStreamRx, NextFunction, ServiceCall } from '../lib';
import { Observable } from 'rxjs';
import * as jspb from 'google-protobuf';

const chain = initChain();

async function testInterceptor(call: ServiceCall<jspb.Message, jspb.Message>, ctx: Context, next: NextFunction) {
  console.log('testInterceptor');
  return await next(call, ctx);
}

async function testController(call: grpc.ServerUnaryCall<TestMessage>, ctx: Context): Promise<TestMessage> {
  chain<grpc.handleUnaryCall<TestMessage, TestMessage>>(TestService.rpcTest);
  return new TestMessage();
}

class TestServiceImpl implements ITestServiceServer {
  rpcTest = chain<grpc.handleUnaryCall<TestMessage, TestMessage>>(
    TestService.rpcTest,
    (call: ServiceCall<jspb.Message, jspb.Message>, ctx: Context, next: NextFunction) => {
      console.log('Interceptor1');
      return next(call, ctx);
    },
    testInterceptor,
    testController,
  );

  clientStreamTest = chain<grpc.handleClientStreamingCall<TestMessage, TestMessage>>(
    TestService.clientStreamTest,
    (call: ServerReadableStreamRx<TestMessage>, ctx: Context): TestMessage => {
      call.source.subscribe((msg) => {
        console.log(`ClientStreamTest received [${ctx.reqId}]: ${JSON.stringify(msg.toObject())}`);
      });

      const resp = new TestMessage();
      resp.setText('Response');
      return resp;
    },
  );

  serverStreamTest = chain<grpc.handleServerStreamingCall<TestMessage, TestMessage>>(
    TestService.serverStreamTest,
    (call: ServerWritableStream<TestMessage>, ctx: Context): Observable<TestMessage> => {
      const obs = new Observable<TestMessage>();
      console.log(`ServerStreamTest received [${ctx.reqId}]: ${JSON.stringify(call.request.toObject())}`);
      return obs;
    },
  );

  biDirStreamTest: grpc.handleBidiStreamingCall<TestMessage, TestMessage> = chain(
    TestService.biDirStreamTest,
    (call: ServiceCall<jspb.Message, jspb.Message>, ctx: Context, next: NextFunction) => {
      return next(call, ctx);
    },
    (call: ServerDuplexStreamRx<TestMessage, TestMessage>, ctx: Context): Observable<TestMessage> => {
      const obs = new Observable<TestMessage>();
      // call.source.subscribe((msg) => {
      //   console.log(`BiDirStreamTest received [${ctx.reqId}]: ${JSON.stringify(msg.toObject())}`);
      // });
      return obs;
    },
  );
}

const app = new grpc.Server();
app.addService(TestService, new TestServiceImpl());
app.bind(`127.0.0.1:3300`, grpc.ServerCredentials.createInsecure());
app.start();
