import grpc from 'grpc';
import * as jspb from 'google-protobuf';
import { EventEmitter } from 'events';

const EVT_UNARY_DATA_SENT = 'unary_data_sent';
const EVT_IN_STREAM_ENDED = 'in_stream_ended';
const EVT_OUT_STREAM_ENDED = 'out_stream_ended';
const EVT_STREAM_MSG_WRITTEN = 'stream_msg_written';

/**
 * Context of a specific call.
 */
export class Context {
  public readonly method: grpc.MethodDefinition<jspb.Message, jspb.Message>;

  /**
   * Request scoped variables
   */
  public locals: { [key: string]: unknown } = {};

  constructor(method: grpc.MethodDefinition<jspb.Message, jspb.Message>) {
    this.method = method;
  }
}

export type NextFunction = () => void;

export type TunnelGate<T extends jspb.Message> = (payload: T, next: NextFunction) => void;

export class Tunnel<T extends jspb.Message> {
  private gates: TunnelGate<T>[] = [];

  public addGate(gate: TunnelGate<T>): void {
    this.gates.push(gate);
  }

  public passPayload(payload: T, index: number, cb?: (passed: boolean) => void): void {
    if (this.gates.length === 0 && cb) {
      cb(true);
    }

    if (index >= this.gates.length) {
      return;
    }

    this.gates[index](payload, () => {
      if (index === this.gates.length - 1 && cb) {
        cb(true);
      }
      this.passPayload(payload, index + 1, cb);
    });
  }
}

export interface InboundTunneledStream<T extends jspb.Message> {
  _inTunnel: Tunnel<T>;
  onMsgIn: (gate: TunnelGate<T>) => void;
  onInStreamEnded: (cb: (err?: grpc.ServiceError | null) => void) => void;
}

export interface OutboundTunneledStream<V extends jspb.Message> {
  _outTunnel: Tunnel<V>;
  sendMsg: (payload: V, cb?: (err?: Error | null) => void) => void;
  sendErr: (err: Error | grpc.ServiceError) => void;
  onMsgOut: (gate: TunnelGate<V>) => void;
  onMsgWritten: (cb: (err: Error | null | undefined, payload: V) => void) => void;
  endOutStream: () => void;
  onOutStreamEnded: (cb: (err?: grpc.ServiceError | null) => void) => void;
}

export interface UnaryRespondable<V extends jspb.Message> {
  sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => void;
  sendUnaryErr: (err: Error | grpc.ServiceError) => void;
  onUnaryResponseSent: (
    cb: (err?: grpc.ServiceError | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
  ) => void;
}

export interface UnaryReadable<T extends jspb.Message> {
  req: T;
}

export interface Contextual {
  ctx: Context;
}

export interface ServerDuplexStreamCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerDuplexStream<T, V>;
}

export interface ServerReadableStreamCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerReadableStream<T>;
  callback: grpc.sendUnaryData<V>;
}

export interface ServerWritableStreamCore<T extends jspb.Message> {
  core: grpc.ServerWritableStream<T>;
}

export interface ServerUnaryCallCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerUnaryCall<T>;
  callback: grpc.sendUnaryData<V>;
}

export type ChainServerDuplexStream<T extends jspb.Message, V extends jspb.Message> = ServerDuplexStreamCore<T, V> &
  InboundTunneledStream<T> &
  OutboundTunneledStream<V> &
  Contextual;

export type ChainServerReadableStream<T extends jspb.Message, V extends jspb.Message> = ServerReadableStreamCore<T, V> &
  InboundTunneledStream<T> &
  UnaryRespondable<V> &
  Contextual;

export type ChainServerWritableStream<T extends jspb.Message, V extends jspb.Message> = ServerWritableStreamCore<T> &
  OutboundTunneledStream<V> &
  UnaryReadable<T> &
  Contextual;

export type ChainServerUnaryCall<T extends jspb.Message, V extends jspb.Message> = ServerUnaryCallCore<T, V> &
  UnaryRespondable<V> &
  UnaryReadable<T> &
  Contextual;

export type ChainServiceCall<T extends jspb.Message, V extends jspb.Message> =
  | ChainServerDuplexStream<T, V>
  | ChainServerReadableStream<T, V>
  | ChainServerWritableStream<T, V>
  | ChainServerUnaryCall<T, V>;

export type GenericServiceCall =
  | ChainServerUnaryCall<jspb.Message, jspb.Message>
  | ChainServerDuplexStream<jspb.Message, jspb.Message>
  | ChainServerReadableStream<jspb.Message, jspb.Message>
  | ChainServerWritableStream<jspb.Message, jspb.Message>;

/**
 * Handler function type for regular, unary RPCs.
 */
export type UnaryCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerUnaryCall<T, V>,
  ready: ReadyFunction,
) => void;

/**
 * Handler function type for client-streaming RPCs, using RX Observables.
 */
export type ClientStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerReadableStream<T, V>,
  ready: ReadyFunction,
) => void;

/**
 * Handler function type for server-streaming RPCs, using RX Observables.
 */
export type ServerStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerWritableStream<T, V>,
  ready: ReadyFunction,
) => void;

/**
 * Handler function type for bidi-streaming RPCs, using RX Observables.
 */
export type BidiStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerDuplexStream<T, V>,
  ready: ReadyFunction,
) => void;

export type GenericCallHandler = (call: GenericServiceCall, ready: ReadyFunction) => void;

export type ChainCallHandler<T extends jspb.Message, V extends jspb.Message> =
  | BidiStreamingCallHandler<T, V>
  | ServerStreamingCallHandler<T, V>
  | ClientStreamingCallHandler<T, V>
  | UnaryCallHandler<T, V>
  | GenericCallHandler;

/**
 * Sends a signal to the Chain that the handler is ready to accept
 * inbound stream data (if the particular call has a request stream) and/or
 * continue to the next call handler (if there is one).
 */
export type ReadyFunction = () => void;

/**
 * Custom error handler.
 */
export type ServiceErrorHandler = (
  err: Error | grpc.ServiceError,
  call: GenericServiceCall,
) => Promise<grpc.ServiceError> | grpc.ServiceError;

/**
 * Chain init options.
 */
export interface ChainOptions {
  errorHandler?: ServiceErrorHandler;
  requestIdLength?: number;
}

type T<K> = K extends grpc.handleCall<infer T, infer _V> ? T : never;
type V<K> = K extends grpc.handleCall<infer _T, infer V> ? V : never;

type CallHandler<K extends grpc.handleCall<T<K>, V<K>>> = K extends grpc.handleUnaryCall<T<K>, V<K>>
  ? UnaryCallHandler<T<K>, V<K>> | GenericCallHandler
  : K extends grpc.handleBidiStreamingCall<T<K>, V<K>>
  ? BidiStreamingCallHandler<T<K>, V<K>> | GenericCallHandler
  : K extends grpc.handleClientStreamingCall<T<K>, V<K>>
  ? ClientStreamingCallHandler<T<K>, V<K>> | GenericCallHandler
  : K extends grpc.handleServerStreamingCall<T<K>, V<K>>
  ? ServerStreamingCallHandler<T<K>, V<K>> | GenericCallHandler
  : never;

/**
 * Call handling chain.
 */
export type Chain = <K extends grpc.handleCall<T<K>, V<K>>>(
  method: grpc.MethodDefinition<T<K>, V<K>>,
  ...handlers: CallHandler<K>[]
) => K;

/**
 * Default error handler.
 *
 * @param err `Error` to handle
 */
export function defaultErrorHandler(err: Error | grpc.ServiceError): grpc.ServiceError {
  let servErr: grpc.ServiceError;
  if (err instanceof Error) {
    servErr = {
      message: err.message,
      name: err.name,
      code: grpc.status.INTERNAL,
    };
  } else {
    servErr = err;
  }

  return servErr;
}

function executeHandlers<T extends jspb.Message, V extends jspb.Message>(
  call: never,
  index: number,
  handlers: ChainCallHandler<T, V>[],
  cb?: (passed: boolean) => void,
) {
  if (handlers.length === 0) {
    throw new Error('Expected at least 1 handler');
  }
  if (index >= handlers.length) {
    return;
  }
  handlers[index](call, () => {
    if (index === handlers.length - 1 && cb) {
      cb(true);
    }
    executeHandlers(call, index + 1, handlers, cb);
  });
}

function wrapUnaryCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: UnaryCallHandler<T, V>[],
  chainOpts?: ChainOptions,
) {
  return (core: grpc.ServerUnaryCall<T>, callback: grpc.sendUnaryData<V>) => {
    const ctx = new Context(method);
    const evts = new EventEmitter();
    let servErr: grpc.ServiceError | null = null;

    const call: ChainServerUnaryCall<T, V> = {
      core,
      callback,
      ctx,
      req: core.request,

      sendUnaryErr: async (err: Error | grpc.ServiceError) => {
        const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
        servErr = await errorHandler(err, call as never);
        callback(servErr, null);
        evts.emit(EVT_UNARY_DATA_SENT, servErr);
      },

      sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => {
        callback(null, payload, trailer, flags);
        evts.emit(EVT_UNARY_DATA_SENT, servErr, payload, trailer, flags);
      },

      onUnaryResponseSent: (
        cb: (err?: grpc.ServiceError | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
      ) => {
        evts.once(EVT_UNARY_DATA_SENT, cb);
      },
    };

    evts.on(EVT_UNARY_DATA_SENT, () => {
      evts.removeAllListeners();
    });

    executeHandlers(call as never, 0, handlers);
  };
}

function wrapClientStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: ClientStreamingCallHandler<T, V>[],
  chainOpts?: ChainOptions,
) {
  return (core: grpc.ServerReadableStream<T>, callback: grpc.sendUnaryData<V>) => {
    const ctx = new Context(method);
    const evts = new EventEmitter();
    const tun = new Tunnel<T>();
    let servErr: grpc.ServiceError | null = null;

    const call: ChainServerReadableStream<T, V> = {
      core,
      callback,
      ctx,
      _inTunnel: tun,

      sendUnaryErr: async (err: Error | grpc.ServiceError) => {
        const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
        servErr = await errorHandler(err, call as never);
        callback(servErr, null);
        evts.emit(EVT_UNARY_DATA_SENT, servErr);
      },

      sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => {
        callback(null, payload, trailer, flags);
        evts.emit(EVT_UNARY_DATA_SENT, servErr, payload, trailer, flags);
      },

      onMsgIn: (gate: TunnelGate<T>) => {
        tun.addGate(gate);
      },

      onUnaryResponseSent: (
        cb: (err?: grpc.ServiceError | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
      ) => {
        evts.once(EVT_UNARY_DATA_SENT, cb);
      },

      onInStreamEnded: (cb: (err?: grpc.ServiceError | null) => void) => {
        evts.once(EVT_IN_STREAM_ENDED, cb);
      },
    };

    let inStreamEnded = false;
    let unaryDataSent = false;

    evts.on(EVT_IN_STREAM_ENDED, () => {
      inStreamEnded = true;
      if (unaryDataSent) {
        evts.removeAllListeners();
      }
    });
    evts.on(EVT_UNARY_DATA_SENT, () => {
      unaryDataSent = true;
      if (inStreamEnded) {
        evts.removeAllListeners();
      }
    });

    executeHandlers(call as never, 0, handlers, (passed) => {
      if (!passed) {
        return;
      }
      core.on('data', (payload: T) => {
        tun.passPayload(payload, 0);
      });
      core.on('end', () => {
        evts.emit(EVT_IN_STREAM_ENDED);
      });
    });
  };
}

function wrapServerStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: ServerStreamingCallHandler<T, V>[],
  chainOpts?: ChainOptions,
) {
  return (core: grpc.ServerWritableStream<T>) => {
    const ctx = new Context(method);
    const evts = new EventEmitter();
    const tun = new Tunnel<V>();
    let servErr: grpc.ServiceError | null = null;

    const call: ChainServerWritableStream<T, V> = {
      core,
      ctx,
      req: core.request,
      _outTunnel: tun,

      sendMsg: (payload: V, cb?: (err?: Error | null) => void) => {
        tun.passPayload(payload, 0, (passed) => {
          if (!passed) {
            return;
          }

          core.write(payload, (err) => {
            if (cb) {
              cb(err);
            }
            evts.emit(EVT_STREAM_MSG_WRITTEN, err, payload);
          });
        });
      },

      sendErr: async (err: Error | grpc.ServiceError) => {
        const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
        servErr = await errorHandler(err, call as never);
        core.once('error', () => {
          core.end();
          evts.emit(EVT_OUT_STREAM_ENDED, servErr);
        });
        core.emit('error', servErr);
      },

      onMsgOut: (gate: TunnelGate<V>) => {
        tun.addGate(gate);
      },

      onMsgWritten: (cb: (err: Error | null | undefined, payload: V) => void) => {
        evts.on(EVT_STREAM_MSG_WRITTEN, cb);
      },

      endOutStream: () => {
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED, servErr);
      },

      onOutStreamEnded: (cb: (err?: grpc.ServiceError | null) => void) => {
        evts.once(EVT_OUT_STREAM_ENDED, cb);
      },
    };

    evts.on(EVT_OUT_STREAM_ENDED, () => {
      evts.removeAllListeners();
    });

    executeHandlers(call as never, 0, handlers);
  };
}

function wrapBidiStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: BidiStreamingCallHandler<T, V>[],
  chainOpts?: ChainOptions,
) {
  return (core: grpc.ServerDuplexStream<T, V>) => {
    const ctx = new Context(method);
    const evts = new EventEmitter();
    const tunIn = new Tunnel<T>();
    const tunOut = new Tunnel<V>();
    let servErr: grpc.ServiceError | null = null;

    const call: ChainServerDuplexStream<T, V> = {
      core,
      ctx,
      _inTunnel: tunIn,
      _outTunnel: tunOut,

      onMsgIn: (gate: TunnelGate<T>) => {
        tunIn.addGate(gate);
      },

      onInStreamEnded: (cb: () => void) => {
        evts.once(EVT_IN_STREAM_ENDED, cb);
      },

      sendMsg: (payload: V, cb?: (err?: Error | null) => void) => {
        tunOut.passPayload(payload, 0, (passed) => {
          if (!passed) {
            return;
          }

          core.write(payload, (err) => {
            if (cb) {
              cb(err);
            }
            evts.emit(EVT_STREAM_MSG_WRITTEN, err, payload);
          });
        });
      },

      sendErr: async (err: Error | grpc.ServiceError) => {
        const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
        servErr = await errorHandler(err, call as never);
        core.once('error', () => {
          core.end();
          evts.emit(EVT_OUT_STREAM_ENDED, servErr);
        });
        core.emit('error', servErr);
      },

      onMsgOut: (gate: TunnelGate<V>) => {
        tunOut.addGate(gate);
      },

      onMsgWritten: (cb: (err: Error | null | undefined, payload: V) => void) => {
        evts.on(EVT_STREAM_MSG_WRITTEN, cb);
      },

      endOutStream: () => {
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED, servErr);
      },

      onOutStreamEnded: (cb: (err?: grpc.ServiceError | null) => void) => {
        evts.once(EVT_OUT_STREAM_ENDED, cb);
      },
    };

    let inStreamEnded = false;
    let outStreamEnded = false;

    evts.on(EVT_IN_STREAM_ENDED, () => {
      inStreamEnded = true;
      if (outStreamEnded) {
        evts.removeAllListeners();
      }
    });
    evts.on(EVT_OUT_STREAM_ENDED, () => {
      outStreamEnded = true;
      if (inStreamEnded) {
        evts.removeAllListeners();
      }
    });

    executeHandlers(call as never, 0, handlers, (passed) => {
      if (!passed) {
        return;
      }
      core.on('data', (payload: T) => {
        tunIn.passPayload(payload, 0);
      });
      core.on('end', () => {
        evts.emit(EVT_IN_STREAM_ENDED);
      });
    });
  };
}

/**
 * Initiates a call handling chain, which allows us to define and reuse
 * `Interceptors` (i.e middleware) and `CallHandlers`.
 *
 * @param errorHandler optional custom error handler
 */
export function initChain(opts?: ChainOptions): Chain {
  // We define the `chain` as a named function so that we can add documentation.

  /**
   * Constructs the actual call handling chain.
   *
   * @param method generated gRPC service call description, required for the inner workings of the chain
   * @param handlers user-provided `Interceptors` and a `CallHandler`. __IMPORTANT__: The last member
   * of this array should __always__ be the `CallHandler`.
   */
  const chain = function <K extends grpc.handleCall<T<K>, V<K>>>(
    method: grpc.MethodDefinition<T<K>, V<K>>,
    ...handlers: CallHandler<K>[]
  ): K {
    // FIXME: Somewhat of a hack to get Typescript to play ball, should probably look
    // for a better solution at some point.
    const methodJspb = (method as unknown) as grpc.MethodDefinition<jspb.Message, jspb.Message>;

    // Wrap the whole chain in a gRPC compatible function. These functions also perform exception
    // catching as well as some resource closing
    if (method.responseStream && method.requestStream) {
      return wrapBidiStreamingCall(methodJspb, handlers as BidiStreamingCallHandler<T<K>, V<K>>[], opts) as K;
    } else if (method.responseStream) {
      return wrapServerStreamingCall(methodJspb, handlers as ServerStreamingCallHandler<T<K>, V<K>>[], opts) as K;
    } else if (method.requestStream) {
      return wrapClientStreamingCall(methodJspb, handlers as ClientStreamingCallHandler<T<K>, V<K>>[], opts) as K;
    } else {
      return wrapUnaryCall(methodJspb, handlers as UnaryCallHandler<T<K>, V<K>>[], opts) as K;
    }
  };

  return chain;
}
