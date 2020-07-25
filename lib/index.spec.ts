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
      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            done();
          },
        ),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const result = await new Promise<TestMessage>((resolve, reject) => {
        createTestClient().rpcTest(new TestMessage(), (err, res) => {
          if (err) {
            return reject(new Error(`Server responded with an unexpected error: ${JSON.stringify(err)}`));
          }
          resolve(res);
        });
      });

      expect(result.getText()).to.equal('Hello Test!');
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
      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            done();
          },
        ),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const err = await new Promise<grpc.ServiceError>((resolve, reject) => {
        createTestClient().rpcTest(new TestMessage(), (err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(err.code).to.equal(grpc.status.UNAUTHENTICATED);
      expect(err.details).to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should execute onUnaryResponseSent callback', async () => {
    let server: grpc.Server | null = null;

    try {
      const chain = lib.initChain();
      let cbPayload: TestMessage | null = null;
      let cbCount = 0;

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            call.onUnaryResponseSent((err, payload) => {
              cbPayload = payload;
              cbCount++;
            });
            done();
          },
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            // The second send should do nothing
            call.sendUnaryData(resp);
            done();
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
            return reject(err);
          }
          resolve(res);
        });
      });

      expect(cbCount).to.equal(1);
      expect(cbPayload).to.not.be.null;
      expect(cbPayload.getText()).to.equal(payload.getText()).to.equal('Hello Test!');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should execute custom error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      let handlerErr: grpc.ServiceError | null = null;
      let handlerCallCount = 0;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerErr = err;
          handlerCallCount++;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, done: lib.DoneFunction) => {
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
            // The third send should do nothing
            call.sendUnaryData(new TestMessage());
            done();
          },
        ),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const err = await new Promise<grpc.ServiceError>((resolve, reject) => {
        createTestClient().rpcTest(new TestMessage(), (err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
      });

      expect(handlerCallCount).to.equal(1);
      expect(handlerErr).to.not.be.null;
      expect(err.code).to.equal(handlerErr.code).to.equal(grpc.status.UNAUTHENTICATED);
      expect(err.details).to.equal(handlerErr.details).to.equal('Invalid token');
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
      let cbCount = 0;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>) => {
          call.onUnaryCallCancelled(() => cbCount++);
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
        setTimeout(() => {
          call.cancel();
        }, 100);
      });

      expect(error.message).to.equal('1 CANCELLED: Cancelled on client');

      // Allow 100 ms of grace time for the onUnaryCallCancelled callback to fire (usually executes after
      // the error is thrown on client side).
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(cbCount).to.equal(1);
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
      const chain = lib.initChain();
      const incomingPayloads: TestMessage[] = [];

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            call.onMsgIn((payload: TestMessage, tdone: lib.DoneFunction) => {
              incomingPayloads.push(payload);
              tdone();
            });
            call.onInStreamEnded(() => {
              const payload = new TestMessage();
              payload.setText('Hello Test!');
              call.sendUnaryData(payload);
              // Second send should be ignored by the library
              call.sendUnaryData(payload);
            });
            done();
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
        payload.setText('Incoming_0');
        stream.write(payload);

        payload.setText('Incoming_1');
        stream.write(payload);

        stream.end();
      });

      expect(incomingPayloads).to.have.length(2);
      expect(incomingPayloads[0].getText()).to.equal('Incoming_0');
      expect(incomingPayloads[1].getText()).to.equal('Incoming_1');
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
      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
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
            done();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const err = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
        setTimeout(() => {
          if (stream.writable) {
            stream.end();
            reject(new Error('Expected an error'));
          }
        }, 500);
      });

      expect(err.code).to.equal(grpc.status.UNAUTHENTICATED);
      expect(err.details).to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should respond with an error and execute custom error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      let customHandlerErr: grpc.ServiceError | null = null;
      let custonHandlerCallCount = 0;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          customHandlerErr = err;
          custonHandlerCallCount++;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            done();
          },
        ),
        serverStreamTest: chain(TestService.serverStreamTest, () => 0),
        biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
      });

      server.start();

      const err = await new Promise<grpc.ServiceError>((resolve, reject) => {
        const stream = createTestClient().clientStreamTest((err) => {
          if (!err) {
            return reject(new Error('Expected an error'));
          }
          resolve(err);
        });
        setTimeout(() => {
          if (stream.writable) {
            stream.end();
            reject(new Error('Expected an error'));
          }
        }, 500);
      });

      expect(customHandlerErr).to.not.be.null;
      expect(custonHandlerCallCount).to.equal(1);
      expect(err.code).to.equal(customHandlerErr.code).to.equal(grpc.status.UNAUTHENTICATED);
      expect(err.details).to.equal(customHandlerErr.details).to.equal('Invalid token');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should execute onUnaryResponseSent callback', async () => {
    let server: grpc.Server | null = null;

    try {
      const chain = lib.initChain();
      let cbPayload: TestMessage | null = null;

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            call.onUnaryResponseSent((err, payload) => {
              cbPayload = payload;
            });
            done();
          },
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            done();
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
        setTimeout(() => {
          if (stream.writable) {
            stream.end();
            reject(new Error('Expected a payload'));
          }
        }, 500);
      });

      expect(cbPayload).to.not.be.null;
      expect(cbPayload.getText()).to.equal(payload.getText()).to.equal('Hello Test!');
    } catch (err) {
      expect.fail(err);
    } finally {
      if (server) {
        server.forceShutdown();
      }
    }
  });

  it('Should not continue to second handler', async () => {
    let server: grpc.Server | null = null;

    try {
      const chain = lib.initChain();
      let checkpoint1 = false;
      let checkpoint2 = false;

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>) => {
            checkpoint1 = true;
            call.sendUnaryData(new TestMessage());
          },
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            checkpoint2 = true;
            done();
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

      expect(checkpoint1).to.be.true;
      expect(checkpoint2).to.be.false;
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
      const chain = lib.initChain();
      let onInStreamEndedCallCount = 0;
      let callErr: Error | grpc.StatusObject | null = null;

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>) => {
            call.onInStreamEnded(() => {
              onInStreamEndedCallCount++;
              callErr = call.err;
            });
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
      expect((callErr as Error).message).to.equal('Some internal streaming error');
      expect(onInStreamEndedCallCount).to.equal(1);
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
      const chain = lib.initChain();
      let onStreamEndCbCount = 0;
      let callCancelled = false;

      server = await createTestServer(
        {
          rpcTest: chain(TestService.rpcTest, () => 0),
          clientStreamTest: chain(
            TestService.clientStreamTest,
            (call: lib.ChainServerReadableStream<TestMessage, TestMessage>) => {
              call.onInStreamEnded(() => {
                onStreamEndCbCount++;
                callCancelled = call.cancelled;
              });
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

      expect(error.message).to.equal('14 UNAVAILABLE: Connection dropped');

      // Allow 100 ms of grace time for the onInStreamEnded callback to fire (usually executes after
      // the error is thrown on client side, in the case of a network failure for example).
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });
      expect(onStreamEndCbCount).to.equal(1);
      expect(callCancelled).to.be.true;
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
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;
      const callCounts = {
        onMsgWritten: 0,
        sendMsgCb: 0,
        onOutStreamEnded: 0,
      };
      const payloadsFromServer: TestMessage[] = [];

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          async (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            _call = call;
            call.onMsgWritten(() => callCounts.onMsgWritten++);
            call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);

            const msg = new TestMessage();
            msg.setText('FromServer_0');
            call.sendMsg(msg, () => callCounts.sendMsgCb++);

            // Artifical delay between stream payloads
            await new Promise((resolve) => setTimeout(() => resolve(), 50));

            msg.setText('FromServer_1');
            call.sendMsg(msg, () => callCounts.sendMsgCb++);

            call.endOutStream();
            // Second end should do nothing
            call.endOutStream();
            // Third send should do nothing
            call.sendMsg(msg);
            done();
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
        onMsgWritten: 2,
        sendMsgCb: 2,
        onOutStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          outStreamEnded: true,
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
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;
      const callCounts = {
        onOutStreamEnded: 0,
      };
      const payloadsFromServer: TestMessage[] = [];

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          async (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            _call = call;
            call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);
            const msg = new TestMessage();
            msg.setText('FromServer_0');
            call.sendMsg(msg);
            call.endOutStream();
            done();
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
        onOutStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: false,
          cancelled: false,
          outStreamEnded: true,
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
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;
      const callCounts = {
        onOutStreamEnded: 0,
      };

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            _call = call;
            call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);
            call.sendErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });

            // Second send should do nothing
            call.sendErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });

            done();
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
        onOutStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          outStreamEnded: true,
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
      let handlerError: grpc.ServiceError | null = null;
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;
      const callCounts = {
        errorHandler: 0,
        onOutStreamEnded: 0,
      };

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
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            _call = call;
            call.sendErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);
            done();
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
        onOutStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          outStreamEnded: true,
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
        onUnaryCallCancelled: 0,
        onOutStreamEnded: 0,
      };
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>, done: lib.DoneFunction) => {
            _call = call;
            call.onUnaryCallCancelled(() => callCounts.onUnaryCallCancelled++);
            call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);
            done();
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

      // Allow 100 ms of grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('1 CANCELLED: Cancelled on client');
      expect(callCounts).to.include({ onUnaryCallCancelled: 1, onOutStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          outStreamEnded: true,
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
      let _call: lib.ChainServerWritableStream<TestMessage, TestMessage> | null = null;
      const callCounts = {
        onOutStreamEnded: 0,
      };

      const chain = lib.initChain();

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(TestService.clientStreamTest, () => 0),
        serverStreamTest: chain(
          TestService.serverStreamTest,
          (call: lib.ChainServerWritableStream<TestMessage, TestMessage>) => {
            _call = call;
            call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);
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
        onOutStreamEnded: 1,
      });
      expect(_call)
        .to.include({
          errOccurred: true,
          cancelled: false,
          outStreamEnded: true,
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
        onUnaryCallCancelled: 0,
        onOutStreamEnded: 0,
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
              call.onOutStreamEnded(() => callCounts.onOutStreamEnded++);
              call.onUnaryCallCancelled(() => callCounts.onUnaryCallCancelled++);
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

      // Allow 100 ms of grace time for all the callbacks to fire
      await new Promise((resolve) => {
        setTimeout(() => resolve(), 100);
      });

      expect(error.message).to.equal('14 UNAVAILABLE: Connection dropped');
      expect(callCounts).to.include({ onUnaryCallCancelled: 1, onOutStreamEnded: 1 });
      expect(_call)
        .to.include({
          cancelled: true,
          errOccurred: false,
          outStreamEnded: true,
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
