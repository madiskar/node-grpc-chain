import 'mocha';
import * as lib from '.';
import * as grpc from '@grpc/grpc-js';
import { TestServiceClient, TestServiceService as TestService, ITestServiceServer } from './proto/test_grpc_pb';
import { TestMessage } from './proto/test_pb';
import { expect } from 'chai';
import * as net from 'net';

class TestProxy {
  private sockets: net.Socket[] = [];

  constructor(private server: net.Server) {}

  public listen() {
    this.server.on('connection', (socket) => this.sockets.push(socket));
    this.server.listen(3840, '0.0.0.0');
  }

  public close() {
    if (this.server.listening) {
      this.server.close();
    }
    this.sockets.forEach((s) => {
      s.end();
    });
  }
}

function createProxy(): TestProxy {
  return new TestProxy(
    net.createServer((localSocket) => {
      const remoteSocket = new net.Socket();
      remoteSocket.connect({ host: '0.0.0.0', port: 3841 });

      localSocket.on('data', (data) => {
        if (remoteSocket.destroyed) {
          return;
        }
        const flushed = remoteSocket.write(data);
        if (!flushed) {
          localSocket.pause();
        }
      });

      remoteSocket.on('data', (data) => {
        if (localSocket.destroyed) {
          return;
        }
        const flushed = localSocket.write(data);
        if (!flushed) {
          remoteSocket.pause();
        }
      });

      localSocket.on('drain', () => {
        remoteSocket.resume();
      });

      remoteSocket.on('drain', () => {
        localSocket.resume();
      });

      localSocket.on('close', () => {
        remoteSocket.end();
      });

      remoteSocket.on('close', () => {
        localSocket.end();
      });
    }),
  );
}

async function createTestServer(impl: ITestServiceServer, behindProxy = false): Promise<grpc.Server> {
  return new Promise<grpc.Server>((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(TestService, impl as never);
    server.bindAsync(`0.0.0.0:${behindProxy ? 3841 : 3840}`, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) {
        return reject(err);
      }
      resolve(server);
    });
  });
}

function createTestClient(): TestServiceClient {
  return new TestServiceClient('0.0.0.0:3840', grpc.ChannelCredentials.createInsecure());
}

describe('Chain Construction', () => {
  it('Should throw error due to missing handlers', async () => {
    const chain = lib.initChain();
    let err: grpc.ServiceError | null = null;
    try {
      const server = await createTestServer({
        rpcTest: chain(TestService.rpcTest),
        clientStreamTest: chain(TestService.clientStreamTest),
        serverStreamTest: chain(TestService.serverStreamTest),
        biDirStreamTest: chain(TestService.biDirStreamTest),
      });
      server.forceShutdown();
    } catch (_err) {
      err = _err;
    }
    expect(err).to.not.be.null;
    expect(err.message).to.equal('Expected at least 1 handler');
  });
});

describe('Unary Calls', () => {
  it('Should respond with a payload', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onUnaryResponseSent: 0,
      };
      let _call: lib.ChainServerUnaryCall<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            // The second send should do nothing
            call.sendUnaryData(resp);
            next();
          },
        ),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const payload = await new Promise<TestMessage>((resolve, reject) => {
        createTestClient().rpcTest(new TestMessage(), (err, res) => {
          if (err) {
            return reject(new Error(`Server responded with an unexpected error: ${JSON.stringify(err)}`));
          }
          resolve(res);
        });
      });

      expect(callCounts).to.include({
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          unaryResponseSent: true,
        })
        .but.not.have.keys('err');
      expect(payload.getText()).to.equal('Hello Test!');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onUnaryResponseSent: 0,
      };
      let _call: lib.ChainServerUnaryCall<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            // The second send should do nothing
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            next();
          },
        ),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        createTestClient().rpcTest(new TestMessage(), (err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(callCounts).to.include({
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          unaryResponseSent: true,
        })
        .and.have.keys('err');
      expect(error.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error and execute error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        errorHandler: 0,
        onUnaryResponseSent: 0,
      };
      let _call: lib.ChainServerUnaryCall<TestMessage, TestMessage> | null = null;
      let handlerError: grpc.ServiceError | null = null;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerError = err;
          callCounts.errorHandler++;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            next();
          },
        ),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        createTestClient().rpcTest(new TestMessage(), (err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(callCounts).to.include({
        errorHandler: 1,
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          unaryResponseSent: true,
        })
        .and.have.keys('err');
      expect(handlerError).to.not.be.null;
      expect(error.code)
        .to.equal(handlerError.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal(handlerError.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onUnaryCancelled: 0,
        onUnaryResponseSent: 0,
      };
      let _call: lib.ChainServerUnaryCall<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>) => {
          _call = call;
          call.onUnaryCancelled(() => callCounts.onUnaryCancelled++);
          call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
        }),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<Error>((resolve, reject) => {
        const call = createTestClient().rpcTest(new TestMessage(), (err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
        setTimeout(() => call.cancel(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('1 CANCELLED: Cancelled on client');
      expect(callCounts).to.include({ onUnaryCancelled: 1, onUnaryResponseSent: 0 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          unaryResponseSent: false,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });
});

describe('Client Streaming Calls', () => {
  it('Should respond with a payload', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
        onUnaryResponseSent: 0,
      };
      const payloadsFromClient: TestMessage[] = [];
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.onStreamData((payload: TestMessage, tnext: lib.NextFunction) => {
              payloadsFromClient.push(payload);
              tnext();
            });
            call.onClientStreamEnded(() => {
              const payload = new TestMessage();
              payload.setText('Hello Test!');
              call.sendUnaryData(payload);
              // Second send should be ignored by the library
              call.sendUnaryData(payload);
            });
            next();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const payload = await new Promise<TestMessage>((resolve, reject) => {
        const stream = createTestClient().clientStreamTest((err, res) => {
          if (err) {
            return reject(err);
          }
          resolve(res);
        });

        const payload = new TestMessage();
        payload.setText('FromClient_0');
        stream.write(payload);

        payload.setText('FromClient_1');
        stream.write(payload);

        stream.end();
      });

      expect(callCounts).to.include({
        onClientStreamEnded: 1,
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          clientStreamEnded: true,
          unaryResponseSent: true,
        })
        .but.not.have.keys('err');
      expect(payloadsFromClient).to.have.length(2);
      expect(payloadsFromClient[0].getText()).to.equal('FromClient_0');
      expect(payloadsFromClient[1].getText()).to.equal('FromClient_1');
      expect(payload.getText()).to.equal('Hello Test!');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
        onUnaryResponseSent: 0,
      };
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            // Second send should do nothing
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            next();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(callCounts).to.include({
        onClientStreamEnded: 1,
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          clientStreamEnded: true,
          unaryResponseSent: true,
        })
        .and.have.keys('err');
      expect(error.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error and execute error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        errorHandler: 0,
        onClientStreamEnded: 0,
        onUnaryResponseSent: 0,
      };
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;
      let handlerError: grpc.ServiceError | null = null;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerError = err;
          callCounts.errorHandler++;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            next();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(callCounts).to.include({
        errorHandler: 1,
        onClientStreamEnded: 1,
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          clientStreamEnded: true,
          unaryResponseSent: true,
        })
        .and.have.keys('err');
      expect(handlerError).to.not.be.null;
      expect(error.code)
        .to.equal(handlerError.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal(handlerError.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should not execute second handler', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onUnaryResponseSent: 0,
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;
      let handler1 = false;
      let handler2 = false;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>) => {
            _call = call;
            handler1 = true;
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.sendUnaryData(new TestMessage());
          },
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            handler2 = true;
            call.onUnaryResponseSent(() => callCounts.onUnaryResponseSent++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            next();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      await new Promise<TestMessage>((resolve, reject) => {
        createTestClient().clientStreamTest((err, res) => {
          if (err) {
            return reject(err);
          }
          resolve(res);
        });
      });

      expect(callCounts).to.include({
        onClientStreamEnded: 1,
        onUnaryResponseSent: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          clientStreamEnded: true,
          unaryResponseSent: true,
        })
        .but.not.have.keys('err');
      expect(handler1).to.be.true;
      expect(handler2).to.be.false;
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            next();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
        setTimeout(() => stream.cancel(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('1 CANCELLED: Cancelled on client');
      expect(callCounts).to.include({ onClientStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          clientStreamEnded: true,
          unaryResponseSent: false,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should fail with an internal error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>) => {
            _call = call;
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            // Simulate an internal failure by emitting directly on the stream
            call.core.emit('error', new Error('Some internal streaming error'));
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<Error>((resolve, reject) => {
        createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(error.message).to.equal('2 UNKNOWN: Some internal streaming error');
      expect(callCounts).to.include({
        onClientStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          clientStreamEnded: true,
          unaryResponseSent: false,
        })
        .and.have.keys('err');
      expect((_call.err as Error).message).to.equal('Some internal streaming error');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel due to network loss', async () => {
    let server: grpc.Server | null = null;
    let proxy: TestProxy | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerReadableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer(
        {
          rpcTest: chain(TestService.rpcTest, () => 0),
          clientStreamTest: chain(
            TestService.clientStreamTest,
            (call: lib.ChainServerReadableStream<TestMessage, TestMessage>) => {
              _call = call;
              call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            },
          ),
          serverStreamTest: chain(TestService.serverStreamTest, () => 0),
          biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
        },
        true,
      );

      server.start();

      proxy = createProxy();
      proxy.listen();

      const error = await new Promise<Error>((resolve, reject) => {
        createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
        setTimeout(() => proxy.close(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('14 UNAVAILABLE: Connection dropped');
      expect(callCounts).to.include({ onClientStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          clientStreamEnded: true,
          unaryResponseSent: false,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
      if (proxy) {
        proxy.close();
      }
    }
  });
});

describe('Server Streaming Calls', () => {
  it('Should respond with two payloads', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onPayloadWritten: 0,
        writeCb: 0,
        onServerStreamEnded: 0,
      };
      const payloadsFromServer: TestMessage[] = [];
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          async (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onPayloadWritten(() => callCounts.onPayloadWritten++);
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);

            const msg = new TestMessage();
            msg.setText('FromServer_0');
            call.write(msg, () => callCounts.writeCb++);

            // Artifical delay between stream payloads
            await new Promise((resolve) => setTimeout(() => resolve(), 50));

            msg.setText('FromServer_1');
            call.write(msg, () => callCounts.writeCb++);

            call.endServerStream();
            // Second end should do nothing
            call.endServerStream();
            // Third send should do nothing
            call.write(msg);
            next();
          },
        ),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      await new Promise((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('data', (payload) => payloadsFromServer.push(payload));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve());
      });

      expect(callCounts).to.include({
        onPayloadWritten: 2,
        writeCb: 2,
        onServerStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          serverStreamEnded: true,
        })
        .but.not.have.keys('err');
      expect(payloadsFromServer).to.have.length(2);
      expect(payloadsFromServer[0].getText()).to.equal('FromServer_0');
      expect(payloadsFromServer[1].getText()).to.equal('FromServer_1');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with one payload', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onServerStreamEnded: 0,
      };
      const payloadsFromServer: TestMessage[] = [];
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          async (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            const msg = new TestMessage();
            msg.setText('FromServer_0');
            call.write(msg);
            call.endServerStream();
            next();
          },
        ),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      await new Promise((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('data', (payload) => payloadsFromServer.push(payload));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve());
      });

      expect(callCounts).to.include({
        onServerStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          serverStreamEnded: true,
        })
        .but.not.have.keys('err');
      expect(payloadsFromServer).to.have.length(1);
      expect(payloadsFromServer[0].getText()).to.equal('FromServer_0');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.writeErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });

            // Second send should do nothing
            call.writeErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });

            next();
          },
        ),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
      });

      expect(callCounts).to.include({
        onServerStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          serverStreamEnded: true,
        })
        .and.have.keys('err');
      expect(error.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error and execute error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        errorHandler: 0,
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;
      let handlerError: grpc.ServiceError | null = null;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerError = err;
          callCounts.errorHandler++;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.writeErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            next();
          },
        ),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
      });

      expect(callCounts).to.include({
        errorHandler: 1,
        onServerStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          serverStreamEnded: true,
        })
        .and.have.keys('err');
      expect(handlerError).to.not.be.null;
      expect(error.code)
        .to.equal(handlerError.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal(handlerError.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onUnaryCancelled: 0,
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onUnaryCancelled(() => callCounts.onUnaryCancelled++);
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            next();
          },
        ),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        setTimeout(() => stream.cancel(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('1 CANCELLED: Cancelled on client');
      expect(callCounts).to.include({ onUnaryCancelled: 1, onServerStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          serverStreamEnded: true,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should fail with an internal error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            // Simulate an internal failure by emitting directly on the stream
            call.core.emit('error', new Error('Some internal streaming error'));
          },
        ),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        setTimeout(() => stream.cancel(), 100);
      });

      expect(error.message).to.equal('2 UNKNOWN: Some internal streaming error');
      expect(callCounts).to.include({
        onServerStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          serverStreamEnded: true,
        })
        .and.have.keys('err');
      expect((_call.err as Error).message).to.equal('Some internal streaming error');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel due to network loss', async () => {
    let server: grpc.Server | null = null;
    let proxy: TestProxy | null = null;

    try {
      const callCounts = {
        onUnaryCancelled: 0,
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer(
        {
          rpcTest: chain(TestService.rpcTest, () => 0),
          clientStreamTest: chain(TestService.clientStreamTest, () => 0),
          serverStreamTest: chain(
            TestService.serverStreamTest,
            (call: lib.ChainServerWritableStream<TestMessage, TestMessage>) => {
              _call = call;
              call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
              call.onUnaryCancelled(() => callCounts.onUnaryCancelled++);
            },
          ),
          biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
        },
        true,
      );

      server.start();

      proxy = createProxy();
      proxy.listen();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().serverStreamTest(new TestMessage());
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        setTimeout(() => proxy.close(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('14 UNAVAILABLE: Connection dropped');
      expect(callCounts).to.include({ onUnaryCancelled: 1, onServerStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          serverStreamEnded: true,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
      if (proxy) {
        proxy.close();
      }
    }
  });
});

describe('Duplex Streaming Calls', () => {
  it('Should exchange two payloads', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
        onServerStreamEnded: 0,
        onPayloadWritten: 0,
        writeCb: 0,
      };
      const payloadsFromClient: TestMessage[] = [];
      const payloadsFromServer: TestMessage[] = [];
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(
          TestService.biDirStreamTest,
          async (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onPayloadWritten(() => callCounts.onPayloadWritten++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);

            call.onStreamData((payload, tnext) => {
              payloadsFromClient.push(payload);
              tnext();
            });

            await new Promise((resolve) => setTimeout(() => resolve(), 100));

            const msg = new TestMessage();
            msg.setText('FromServer_0');
            call.write(msg, () => callCounts.writeCb++);

            await new Promise((resolve) => setTimeout(() => resolve(), 20));

            msg.setText('FromServer_1');
            call.write(msg, () => callCounts.writeCb++);

            call.endServerStream();
            // Second end should do nothing
            call.endServerStream();

            // Third send should do nothing
            call.write(msg, () => callCounts.writeCb++);
            next();
          },
        ),
      });

      server.start();

      await new Promise(async (resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('data', (payload) => payloadsFromServer.push(payload));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve());

        const msg = new TestMessage();
        msg.setText('FromClient_0');
        stream.write(msg);

        await new Promise((resolve) => setTimeout(() => resolve(), 20));

        msg.setText('FromClient_1');
        stream.write(msg);

        stream.end();
      });

      expect(callCounts).to.include({
        onPayloadWritten: 2,
        writeCb: 2,
        onServerStreamEnded: 1,
        onClientStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .but.not.have.keys('err');
      expect(payloadsFromServer).to.have.length(2);
      expect(payloadsFromServer[0].getText()).to.equal('FromServer_0');
      expect(payloadsFromServer[1].getText()).to.equal('FromServer_1');
      expect(payloadsFromClient).to.have.length(2);
      expect(payloadsFromClient[0].getText()).to.equal('FromClient_0');
      expect(payloadsFromClient[1].getText()).to.equal('FromClient_1');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with one payload', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onServerStreamEnded: 0,
        onClientStreamEnded: 0,
        onPayloadWritten: 0,
      };
      const payloadsFromServer: TestMessage[] = [];
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(
          TestService.biDirStreamTest,
          async (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.onPayloadWritten(() => callCounts.onPayloadWritten++);

            await new Promise((resolve) => setTimeout(() => resolve(), 100));

            const msg = new TestMessage();
            msg.setText('FromServer_0');
            call.write(msg);
            call.endServerStream();
            next();
          },
        ),
      });

      server.start();

      await new Promise((resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('data', (payload) => payloadsFromServer.push(payload));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve());
        stream.end();
      });

      expect(callCounts).to.include({
        onServerStreamEnded: 1,
        onClientStreamEnded: 1,
        onPayloadWritten: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .but.not.have.keys('err');
      expect(payloadsFromServer).to.have.length(1);
      expect(payloadsFromServer[0].getText()).to.equal('FromServer_0');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onServerStreamEnded: 0,
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(
          TestService.biDirStreamTest,
          (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.writeErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });

            // Second send should do nothing
            call.writeErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });

            next();
          },
        ),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        stream.end();
      });

      expect(callCounts).to.include({
        onServerStreamEnded: 1,
        onClientStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .and.have.keys('err');
      expect(error.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error and execute error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        errorHandler: 0,
        onServerStreamEnded: 0,
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;
      let handlerError: grpc.ServiceError | null = null;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerError = err;
          callCounts.errorHandler++;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(
          TestService.biDirStreamTest,
          (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            call.writeErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            next();
          },
        ),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        stream.end();
      });

      expect(callCounts).to.include({
        errorHandler: 1,
        onServerStreamEnded: 1,
        onClientStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .and.have.keys('err');
      expect(handlerError).to.not.be.null;
      expect(error.code)
        .to.equal(handlerError.code)
        .to.equal((_call.err as grpc.ServiceError).code)
        .to.equal(grpc.status.UNAUTHENTICATED);
      expect(error.details)
        .to.equal(handlerError.details)
        .to.equal((_call.err as grpc.ServiceError).details)
        .to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(
          TestService.biDirStreamTest,
          (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            next();
          },
        ),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        setTimeout(() => stream.cancel(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('1 CANCELLED: Cancelled on client');
      expect(callCounts).to.include({ onClientStreamEnded: 1, onServerStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should fail with an internal error', async () => {
    let server: grpc.Server | null = null;

    try {
      const callCounts = {
        onServerStreamEnded: 0,
        onClientStreamEnded: 0,
      };
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(
          TestService.biDirStreamTest,
          (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
            _call = call;
            call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
            call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
            // Simulate an internal failure by emitting directly on the stream
            call.core.emit('error', new Error('Some internal streaming error'));
            next();
          },
        ),
      });

      server.start();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
      });

      expect(error.message).to.equal('2 UNKNOWN: Some internal streaming error');
      expect(callCounts).to.include({
        onServerStreamEnded: 1,
        onClientStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .and.have.keys('err');
      expect((_call.err as Error).message).to.equal('Some internal streaming error');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should cancel due to network loss', async () => {
    let server: grpc.Server | null = null;
    let proxy: TestProxy | null = null;

    try {
      const callCounts = {
        onClientStreamEnded: 0,
        onServerStreamEnded: 0,
      };
      let _call: lib.ChainServerDuplexStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer(
        {
          rpcTest: chain(TestService.rpcTest, () => 0),
          clientStreamTest: chain(TestService.clientStreamTest, () => 0),
          serverStreamTest: chain(TestService.serverStreamTest, () => 0),
          biDirStreamTest: chain(
            TestService.biDirStreamTest,
            (call: lib.ChainServerDuplexStream<TestMessage, TestMessage>, next: lib.NextFunction) => {
              _call = call;
              call.onServerStreamEnded(() => callCounts.onServerStreamEnded++);
              call.onClientStreamEnded(() => callCounts.onClientStreamEnded++);
              next();
            },
          ),
        },
        true,
      );

      server.start();

      proxy = createProxy();
      proxy.listen();

      const error = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().biDirStreamTest();
        stream.on('end', () => reject(new Error('Expected error before stream end')));
        stream.on('data', () => reject(new Error('Expected error before data')));
        stream.on('error', (err) => resolve(err as grpc.ServiceError));
        setTimeout(() => proxy.close(), 100);
      });

      // Provide some grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('14 UNAVAILABLE: Connection dropped');
      expect(callCounts).to.include({ onClientStreamEnded: 1, onServerStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          serverStreamEnded: true,
          clientStreamEnded: true,
        })
        .but.not.have.keys('err');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
      if (proxy) {
        proxy.close();
      }
    }
  });
});
