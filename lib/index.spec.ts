import * as lib from '.';
import * as grpc from '@grpc/grpc-js';
import { TestServiceClient, TestServiceService as TestService, ITestServiceServer } from './proto/test_grpc_pb';
import { TestMessage } from './proto/test_pb';
import { expect } from 'chai';
import 'mocha';

async function createTestServer(impl: ITestServiceServer): Promise<grpc.Server> {
  return new Promise<grpc.Server>((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(TestService, impl as never);
    server.bindAsync('0.0.0.0:3840', grpc.ServerCredentials.createInsecure(), (err) => {
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
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            ready();
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
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            ready();
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

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.onUnaryResponseSent((err, payload) => {
              cbPayload = payload;
            });
            ready();
          },
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            ready();
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

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerErr = err;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(
          TestService.rpcTest,
          (call: lib.ChainServerUnaryCall<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            ready();
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
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.onMsgIn((payload: TestMessage, next: lib.NextGateFunction) => {
              incomingPayloads.push(payload);
              next();
            });
            call.onInStreamEnded(() => {
              const payload = new TestMessage();
              payload.setText('Hello Test!');
              call.sendUnaryData(payload);
            });
            ready();
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
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            ready();
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

  it('Should execute onUnaryResponseSent callback', async () => {
    let server: grpc.Server | null = null;

    try {
      const chain = lib.initChain();
      let cbPayload: TestMessage | null = null;

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.onUnaryResponseSent((err, payload) => {
              cbPayload = payload;
            });
            ready();
          },
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            const resp = new TestMessage();
            resp.setText('Hello Test!');
            call.sendUnaryData(resp);
            ready();
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

  it('Should execute custom error handler', async () => {
    let server: grpc.Server | null = null;

    try {
      let handlerErr: grpc.ServiceError | null = null;

      const chain = lib.initChain({
        errorHandler: (err: grpc.ServiceError): grpc.ServiceError => {
          handlerErr = err;
          return err;
        },
      });

      server = await createTestServer({
        rpcTest: chain(TestService.rpcTest, () => 0),
        clientStreamTest: chain(
          TestService.clientStreamTest,
          (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
            call.sendUnaryErr({
              code: grpc.status.UNAUTHENTICATED,
              metadata: new grpc.Metadata(),
              details: 'Invalid token',
            });
            ready();
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

  // it('Should not continue to second handler', async () => {
  //   let server: grpc.Server | null = null;

  //   try {
  //     const chain = lib.initChain();
  //     let checkpoint1 = false;
  //     let checkpoint2 = false;

  //     server = await createTestServer({
  //       rpcTest: chain(TestService.rpcTest, () => 0),
  //       clientStreamTest: chain(
  //         TestService.clientStreamTest,
  //         (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
  //           checkpoint1 = true;
  //           //call.sendUnaryData(new TestMessage());
  //           call.onInStreamEnded(() => {
  //             console.log('closed');
  //           });
  //           call.core.on('end', () => {
  //             console.log('ended');
  //           });
  //           // call.core.on('cancelled', () => {
  //           //   console.log('cancelled');
  //           // });
  //           ready();
  //         },
  //         (call: lib.ChainServerReadableStream<TestMessage, TestMessage>, ready: lib.ReadyFunction) => {
  //           checkpoint2 = true;
  //           //ready();
  //         },
  //       ),
  //       serverStreamTest: chain(TestService.serverStreamTest, () => 0),
  //       biDirStreamTest: chain(TestService.biDirStreamTest, () => 0),
  //     });

  //     server.start();

  //     await new Promise<TestMessage>((resolve, reject) => {
  //       const stream = createTestClient().clientStreamTest((err, res) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(res);
  //       });

  //       let status: grpc.StatusObject | null = null;
  //       stream.on('status', (_status) => {
  //         console.log('status');
  //         console.log(JSON.stringify(_status));
  //         status = _status;
  //       });

  //       setTimeout(() => {
  //         if (!status) {
  //           console.log('asd2');
  //           stream.end();
  //           //reject(new Error('Expected a payload'));
  //         }
  //       }, 500);
  //     });

  //     expect(checkpoint1).to.be.true;
  //     expect(checkpoint2).to.be.false;
  //   } catch (err) {
  //     expect.fail(err);
  //   } finally {
  //     if (server) {
  //       server.forceShutdown();
  //     }
  //   }
  // });
});
