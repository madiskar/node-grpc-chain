import * as grpc from '@grpc/grpc-js';
import {
  handleServerStreamingCall,
  handleBidiStreamingCall,
  handleClientStreamingCall,
  handleUnaryCall,
  HandleCall,
} from '@grpc/grpc-js/build/src/server-call';
import * as jspb from 'google-protobuf';
import { EventEmitter } from 'events';

const EVT_UNARY_DATA_SENT = 'unary_data_sent';
const EVT_IN_STREAM_ENDED = 'in_stream_ended';
const EVT_OUT_STREAM_ENDED = 'out_stream_ended';
const EVT_STREAM_MSG_WRITTEN = 'stream_msg_written';

/**
 * Context of a specific call.
 */
export interface Context {
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>;
  locals: { [key: string]: unknown };
}

export type NextGateFunction = () => void;

export type TunnelGate<T extends jspb.Message> = (payload: T, next: NextGateFunction) => void;

export class Tunnel<T extends jspb.Message> {
  private gates: TunnelGate<T>[] = [];

  public addGate(gate: TunnelGate<T>): void {
    this.gates.push(gate);
  }

  public passPayload(payload: T, index = 0, cb?: () => void): void {
    if (this.gates.length === 0 && cb) {
      cb();
    }

    if (index >= this.gates.length) {
      return;
    }

    this.gates[index](payload, () => {
      if (index === this.gates.length - 1 && cb) {
        cb();
      }
      this.passPayload(payload, index + 1, cb);
    });
  }
}

export interface InboundTunneledStream<T extends jspb.Message> {
  _inTunnel: Tunnel<T>;
  onMsgIn: (gate: TunnelGate<T>) => void;
  onInStreamEnded: (cb: () => void) => void;
}

export interface OutboundTunneledStream<V extends jspb.Message> {
  _outTunnel: Tunnel<V>;
  sendMsg: (payload: V, cb?: () => void) => void;
  sendErr: (err: grpc.ServiceError) => void;
  onMsgOut: (gate: TunnelGate<V>) => void;
  onMsgWritten: (cb: (payload: V) => void) => void;
  endOutStream: () => void;
  onOutStreamEnded: (cb: () => void) => void;
}

export interface UnaryRespondable<V extends jspb.Message> {
  sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => void;
  sendUnaryErr: (err: grpc.ServiceError) => void;
  onUnaryResponseSent: (
    cb: (err?: grpc.ServiceError | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
  ) => void;
}

export interface UnaryReadable<T extends jspb.Message> {
  req: T | null;
}

export interface Common {
  ctx: Context;
  err?: grpc.ServiceError;
}

export interface ServerDuplexStreamCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerDuplexStream<T, V>;
}

export interface ServerReadableStreamCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerReadableStream<T, V>;
  callback: grpc.sendUnaryData<V>;
}

export interface ServerWritableStreamCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerWritableStream<T, V>;
}

export interface ServerUnaryCallCore<T extends jspb.Message, V extends jspb.Message> {
  core: grpc.ServerUnaryCall<T, V>;
  callback: grpc.sendUnaryData<V>;
}

export type ChainServerDuplexStream<T extends jspb.Message, V extends jspb.Message> = ServerDuplexStreamCore<T, V> &
  InboundTunneledStream<T> &
  OutboundTunneledStream<V> &
  Common;

export type ChainServerReadableStream<T extends jspb.Message, V extends jspb.Message> = ServerReadableStreamCore<T, V> &
  InboundTunneledStream<T> &
  UnaryRespondable<V> &
  Common;

export type ChainServerWritableStream<T extends jspb.Message, V extends jspb.Message> = ServerWritableStreamCore<T, V> &
  OutboundTunneledStream<V> &
  UnaryReadable<T> &
  Common;

export type ChainServerUnaryCall<T extends jspb.Message, V extends jspb.Message> = ServerUnaryCallCore<T, V> &
  UnaryRespondable<V> &
  UnaryReadable<T> &
  Common;

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
  err: grpc.ServiceError,
  call: GenericServiceCall,
) => Promise<grpc.ServiceError> | grpc.ServiceError;

/**
 * Chain init options.
 */
export interface ChainOptions {
  errorHandler?: ServiceErrorHandler;
}

type T<K> = K extends HandleCall<infer T, infer _V> ? T : never;
type V<K> = K extends HandleCall<infer _T, infer V> ? V : never;

type CallHandler<K extends HandleCall<T<K>, V<K>>> = K extends handleUnaryCall<T<K>, V<K>>
  ? UnaryCallHandler<T<K>, V<K>> | GenericCallHandler
  : K extends handleBidiStreamingCall<T<K>, V<K>>
  ? BidiStreamingCallHandler<T<K>, V<K>> | GenericCallHandler
  : K extends handleClientStreamingCall<T<K>, V<K>>
  ? ClientStreamingCallHandler<T<K>, V<K>> | GenericCallHandler
  : K extends handleServerStreamingCall<T<K>, V<K>>
  ? ServerStreamingCallHandler<T<K>, V<K>> | GenericCallHandler
  : never;

/**
 * Call handling chain.
 */
export type Chain = <K extends HandleCall<T<K>, V<K>>>(
  method: grpc.MethodDefinition<T<K>, V<K>>,
  ...handlers: CallHandler<K>[]
) => K;

function executeHandlers<T extends jspb.Message, V extends jspb.Message>(
  call: never,
  index: number,
  handlers: ChainCallHandler<T, V>[],
  cb?: () => void,
) {
  if (index >= handlers.length) {
    return;
  }
  handlers[index](call, () => {
    if (index === handlers.length - 1 && cb) {
      cb();
    }
    executeHandlers(call, index + 1, handlers, cb);
  });
}

function wrapUnaryCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: UnaryCallHandler<T, V>[],
  chainOpts: ChainOptions,
) {
  return (core: grpc.ServerUnaryCall<T, V>, callback: grpc.sendUnaryData<V>) => {
    const ctx: Context = { method, locals: {} };
    const evts = new EventEmitter();
    let error = false;

    const call: ChainServerUnaryCall<T, V> = {
      core,
      callback,
      ctx,
      req: core.request,

      sendUnaryErr: async (err: grpc.ServiceError) => {
        error = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        callback(call.err, null);
        evts.emit(EVT_UNARY_DATA_SENT, call.err);
      },

      sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => {
        if (!error) {
          callback(null, payload, trailer, flags);
          evts.emit(EVT_UNARY_DATA_SENT, call.err, payload, trailer, flags);
        }
      },

      onUnaryResponseSent: (
        cb: (err?: grpc.ServiceError | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
      ) => {
        evts.once(EVT_UNARY_DATA_SENT, cb);
      },
    };

    evts.once(EVT_UNARY_DATA_SENT, () => {
      evts.removeAllListeners();
    });

    executeHandlers(call as never, 0, handlers);
  };
}

function wrapClientStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: ClientStreamingCallHandler<T, V>[],
  chainOpts: ChainOptions,
) {
  return (core: grpc.ServerReadableStream<T, V>, callback: grpc.sendUnaryData<V>) => {
    const ctx: Context = { method, locals: {} };
    const evts = new EventEmitter();
    const tun = new Tunnel<T>();
    let error = false;

    const call: ChainServerReadableStream<T, V> = {
      core,
      callback,
      ctx,
      _inTunnel: tun,

      sendUnaryErr: async (err: grpc.ServiceError) => {
        error = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        callback(call.err, null);
        evts.emit(EVT_UNARY_DATA_SENT, call.err);
      },

      sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => {
        if (!error) {
          callback(null, payload, trailer, flags);
          evts.emit(EVT_UNARY_DATA_SENT, call.err, payload, trailer, flags);
          evts.emit(EVT_IN_STREAM_ENDED);
        }
      },

      onMsgIn: (gate: TunnelGate<T>) => {
        tun.addGate(gate);
      },

      onUnaryResponseSent: (
        cb: (err?: grpc.ServiceError | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
      ) => {
        evts.once(EVT_UNARY_DATA_SENT, cb);
      },

      onInStreamEnded: (cb: () => void) => {
        evts.once(EVT_IN_STREAM_ENDED, cb);
      },
    };

    let inStreamEnded = false;
    let unaryDataSent = false;

    evts.once(EVT_IN_STREAM_ENDED, () => {
      inStreamEnded = true;
      if (unaryDataSent) {
        evts.removeAllListeners();
      }
    });
    evts.once(EVT_UNARY_DATA_SENT, () => {
      unaryDataSent = true;
      if (inStreamEnded) {
        evts.removeAllListeners();
      }
    });

    core.on('end', () => {
      evts.emit(EVT_IN_STREAM_ENDED);
    });

    executeHandlers(call as never, 0, handlers, () => {
      core.on('data', (payload: T) => {
        tun.passPayload(payload);
      });
    });
  };
}

function wrapServerStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: ServerStreamingCallHandler<T, V>[],
  chainOpts: ChainOptions,
) {
  return (core: grpc.ServerWritableStream<T, V>) => {
    const ctx: Context = { method, locals: {} };
    const evts = new EventEmitter();
    const tun = new Tunnel<V>();
    let error = false;

    const call: ChainServerWritableStream<T, V> = {
      core,
      ctx,
      req: core.request,
      _outTunnel: tun,

      sendMsg: (payload: V, cb?: () => void) => {
        if (error) {
          return;
        }

        tun.passPayload(payload, 0, () => {
          core.write(payload, () => {
            if (cb) {
              cb();
            }
            evts.emit(EVT_STREAM_MSG_WRITTEN, payload);
          });
        });
      },

      sendErr: async (err: grpc.ServiceError) => {
        error = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        core.once('error', () => {
          core.end();
          evts.emit(EVT_OUT_STREAM_ENDED);
        });
        core.emit('error', call.err);
      },

      onMsgOut: (gate: TunnelGate<V>) => {
        tun.addGate(gate);
      },

      onMsgWritten: (cb: (payload: V) => void) => {
        evts.on(EVT_STREAM_MSG_WRITTEN, cb);
      },

      endOutStream: () => {
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      },

      onOutStreamEnded: (cb: () => void) => {
        evts.once(EVT_OUT_STREAM_ENDED, cb);
      },
    };

    evts.once(EVT_OUT_STREAM_ENDED, () => {
      evts.removeAllListeners();
    });

    executeHandlers(call as never, 0, handlers);
  };
}

function wrapBidiStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handlers: BidiStreamingCallHandler<T, V>[],
  chainOpts: ChainOptions,
) {
  return (core: grpc.ServerDuplexStream<T, V>) => {
    const ctx: Context = { method, locals: {} };
    const evts = new EventEmitter();
    const tunIn = new Tunnel<T>();
    const tunOut = new Tunnel<V>();
    let error = false;

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

      sendMsg: (payload: V, cb?: () => void) => {
        if (error) {
          return;
        }

        tunOut.passPayload(payload, 0, () => {
          core.write(payload, () => {
            if (cb) {
              cb();
            }
            evts.emit(EVT_STREAM_MSG_WRITTEN, payload);
          });
        });
      },

      sendErr: async (err: grpc.ServiceError) => {
        error = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        core.once('error', () => {
          core.end();
          evts.emit(EVT_OUT_STREAM_ENDED);
          evts.emit(EVT_IN_STREAM_ENDED);
        });
        core.emit('error', call.err);
      },

      onMsgOut: (gate: TunnelGate<V>) => {
        tunOut.addGate(gate);
      },

      onMsgWritten: (cb: (payload: V) => void) => {
        evts.on(EVT_STREAM_MSG_WRITTEN, cb);
      },

      endOutStream: () => {
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      },

      onOutStreamEnded: (cb: (err?: grpc.ServiceError | null) => void) => {
        evts.once(EVT_OUT_STREAM_ENDED, cb);
      },
    };

    let inStreamEnded = false;
    let outStreamEnded = false;

    evts.once(EVT_IN_STREAM_ENDED, () => {
      inStreamEnded = true;
      if (outStreamEnded) {
        evts.removeAllListeners();
      }
    });
    evts.once(EVT_OUT_STREAM_ENDED, () => {
      outStreamEnded = true;
      if (inStreamEnded) {
        evts.removeAllListeners();
      }
    });

    core.on('end', () => {
      evts.emit(EVT_IN_STREAM_ENDED);
    });

    executeHandlers(call as never, 0, handlers, () => {
      core.on('data', (payload: T) => {
        tunIn.passPayload(payload);
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
export function initChain(opts: ChainOptions = {}): Chain {
  // We define the `chain` as a named function so that we can add documentation.

  /**
   * Constructs the actual call handling chain.
   *
   * @param method generated gRPC service call description, required for the inner workings of the chain
   * @param handlers user-provided `Interceptors` and a `CallHandler`. __IMPORTANT__: The last member
   * of this array should __always__ be the `CallHandler`.
   */
  const chain = function <K extends HandleCall<T<K>, V<K>>>(
    method: grpc.MethodDefinition<T<K>, V<K>>,
    ...handlers: CallHandler<K>[]
  ): K {
    if (handlers.length === 0) {
      throw new Error('Expected at least 1 handler');
    }

    // Somewhat of a hack to get Typescript to play ball, should probably look
    // for a better solution/
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
