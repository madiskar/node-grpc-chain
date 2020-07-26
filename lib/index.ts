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
const EVT_UNARY_CALL_CANCELLED = 'unary_call_cancelled';

/**
 * Context of a specific call.
 */
export interface Context {
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>;
  locals: { [key: string]: unknown };
}

/**
 * Sends a signal to the Chain that the handler is ready to accept
 * inbound stream data (if the particular call has a request stream) and/or
 * continue to the next call handler (if there is one).
 *
 * In the case of Tunnels, DoneFunction serves a similar purpose, in
 * that it instructs the Tunnel to either continue to the next Gate or
 * consider the payload as `ready for transport` (in the case of outgoing
 * tunnels).
 */
export type DoneFunction = () => void;

export type TunnelGate<T extends jspb.Message> = (payload: T, tdone: DoneFunction) => void;

export class Tunnel<T extends jspb.Message> {
  private gates: TunnelGate<T>[] = [];

  public addGate(gate: TunnelGate<T>): void {
    this.gates.push(gate);
  }

  public passPayload(payload: T, index = 0): void {
    if (index >= this.gates.length) {
      return;
    }
    this.gates[index](payload, () => this.passPayload(payload, index + 1));
  }
}

export interface InboundTunneledStream<T extends jspb.Message> {
  _tun: Tunnel<T>;
  inStreamEnded: boolean;
  onMsgIn: (gate: TunnelGate<T>) => void;
  onInStreamEnded: (cb: () => void) => void;
}

export interface OutboundTunneledStream<V extends jspb.Message> {
  outStreamEnded: boolean;
  sendMsg: (payload: V, cb?: () => void) => void;
  sendErr: (err: grpc.StatusObject) => void;
  onMsgWritten: (cb: (payload: V) => void) => void;
  endOutStream: () => void;
  onOutStreamEnded: (cb: () => void) => void;
}

export interface UnaryRespondable<V extends jspb.Message> {
  unaryResponseSent: boolean;
  sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => void;
  sendUnaryErr: (err: grpc.StatusObject) => void;
  onUnaryResponseSent: (
    cb: (err?: grpc.StatusObject | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
  ) => void;
}

export interface UnaryReadable<T extends jspb.Message> {
  req: T | null;
  onUnaryCallCancelled: (cb: () => void) => void;
}

export interface Common {
  ctx: Context;
  errOccurred: boolean;
  err?: Error | grpc.StatusObject;
  cancelled: boolean;
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
  done: DoneFunction,
) => void;

/**
 * Handler function type for client-streaming RPCs, using RX Observables.
 */
export type ClientStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerReadableStream<T, V>,
  done: DoneFunction,
) => void;

/**
 * Handler function type for server-streaming RPCs, using RX Observables.
 */
export type ServerStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerWritableStream<T, V>,
  done: DoneFunction,
) => void;

/**
 * Handler function type for bidi-streaming RPCs, using RX Observables.
 */
export type BidiStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ChainServerDuplexStream<T, V>,
  done: DoneFunction,
) => void;

export type GenericCallHandler = (call: GenericServiceCall, done: DoneFunction) => void;

export type ChainCallHandler<T extends jspb.Message, V extends jspb.Message> =
  | BidiStreamingCallHandler<T, V>
  | ServerStreamingCallHandler<T, V>
  | ClientStreamingCallHandler<T, V>
  | UnaryCallHandler<T, V>
  | GenericCallHandler;

/**
 * Custom error handler.
 */
export type ServiceErrorHandler = (
  err: grpc.StatusObject,
  call: GenericServiceCall,
) => Promise<grpc.StatusObject> | grpc.StatusObject;

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

    evts.setMaxListeners(0);

    const call: ChainServerUnaryCall<T, V> = {
      core,
      callback,
      ctx,
      req: core.request,
      cancelled: false,
      unaryResponseSent: false,
      errOccurred: false,

      sendUnaryErr: async (err: grpc.StatusObject) => {
        if (call.unaryResponseSent || call.errOccurred || call.cancelled) {
          return;
        }
        call.errOccurred = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        call.unaryResponseSent = true;
        callback(call.err, null);
        evts.emit(EVT_UNARY_DATA_SENT, call.err);
      },

      sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => {
        if (call.unaryResponseSent || call.errOccurred || call.cancelled) {
          return;
        }
        call.unaryResponseSent = true;
        callback(null, payload, trailer, flags);
        evts.emit(EVT_UNARY_DATA_SENT, call.err, payload, trailer, flags);
      },

      onUnaryResponseSent: (
        cb: (err?: grpc.StatusObject | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
      ) => {
        evts.once(EVT_UNARY_DATA_SENT, cb);
      },

      onUnaryCallCancelled: (cb: () => void) => {
        evts.once(EVT_UNARY_CALL_CANCELLED, cb);
      },
    };

    core.once('cancelled', () => {
      if (call.unaryResponseSent || call.errOccurred) {
        return;
      }
      call.cancelled = true;
      evts.emit(EVT_UNARY_CALL_CANCELLED);
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

    evts.setMaxListeners(0);

    const call: ChainServerReadableStream<T, V> = {
      core,
      callback,
      ctx,
      _tun: tun,
      cancelled: false,
      errOccurred: false,
      unaryResponseSent: false,
      inStreamEnded: false,

      sendUnaryErr: async (err: grpc.StatusObject) => {
        if (call.unaryResponseSent || call.errOccurred || call.cancelled) {
          return;
        }
        call.errOccurred = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        if (!call.inStreamEnded) {
          call.inStreamEnded = true;
          evts.emit(EVT_IN_STREAM_ENDED);
        }
        call.unaryResponseSent = true;
        callback(call.err, null);
        evts.emit(EVT_UNARY_DATA_SENT, call.err);
      },

      sendUnaryData: (payload: V, trailer?: grpc.Metadata, flags?: number) => {
        if (call.unaryResponseSent || call.errOccurred || call.cancelled) {
          return;
        }
        call.unaryResponseSent = true;
        callback(null, payload, trailer, flags);
        evts.emit(EVT_UNARY_DATA_SENT, call.err, payload, trailer, flags);
        if (!call.inStreamEnded) {
          call.inStreamEnded = true;
          evts.emit(EVT_IN_STREAM_ENDED);
        }
      },

      onMsgIn: (gate: TunnelGate<T>) => {
        tun.addGate(gate);
      },

      onUnaryResponseSent: (
        cb: (err?: grpc.StatusObject | null, payload?: V, trailer?: grpc.Metadata, flags?: number) => void,
      ) => {
        evts.once(EVT_UNARY_DATA_SENT, cb);
      },

      onInStreamEnded: (cb: () => void) => {
        evts.once(EVT_IN_STREAM_ENDED, cb);
      },
    };

    core.once('end', () => {
      if (!call.inStreamEnded) {
        call.inStreamEnded = true;
        evts.emit(EVT_IN_STREAM_ENDED);
      }
    });

    core.once('error', (err) => {
      if (!call.err) {
        call.errOccurred = true;
        call.err = err;
      }
      if (!call.inStreamEnded) {
        call.inStreamEnded = true;
        evts.emit(EVT_IN_STREAM_ENDED);
      }
    });

    core.once('cancelled', () => {
      if (call.unaryResponseSent || call.errOccurred || call.cancelled) {
        return;
      }
      call.cancelled = true;
      if (!call.inStreamEnded) {
        call.inStreamEnded = true;
        evts.emit(EVT_IN_STREAM_ENDED);
      }
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

    evts.setMaxListeners(0);

    const call: ChainServerWritableStream<T, V> = {
      core,
      ctx,
      req: core.request,
      cancelled: false,
      errOccurred: false,
      outStreamEnded: false,

      sendMsg: (payload: V, cb?: () => void) => {
        if (call.errOccurred || call.cancelled || call.outStreamEnded) {
          return;
        }
        core.write(payload, () => {
          if (cb) {
            cb();
          }
          evts.emit(EVT_STREAM_MSG_WRITTEN, payload);
        });
      },

      sendErr: async (err: grpc.StatusObject) => {
        if (call.errOccurred || call.cancelled || call.outStreamEnded) {
          return;
        }
        call.errOccurred = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        core.emit('error', call.err);
      },

      endOutStream: () => {
        if (call.errOccurred || call.cancelled || call.outStreamEnded) {
          return;
        }
        call.outStreamEnded = true;
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      },

      onMsgWritten: (cb: (payload: V) => void) => {
        evts.on(EVT_STREAM_MSG_WRITTEN, cb);
      },

      onOutStreamEnded: (cb: () => void) => {
        evts.once(EVT_OUT_STREAM_ENDED, cb);
      },

      onUnaryCallCancelled: (cb: () => void) => {
        evts.once(EVT_UNARY_CALL_CANCELLED, cb);
      },
    };

    core.once('error', (err) => {
      if (!call.err) {
        call.errOccurred = true;
        call.err = err;
      }
      if (!call.outStreamEnded) {
        call.outStreamEnded = true;
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      }
    });

    core.once('cancelled', () => {
      if (call.errOccurred || call.cancelled || call.outStreamEnded) {
        return;
      }
      call.cancelled = true;
      call.outStreamEnded = true;
      core.end();
      evts.emit(EVT_UNARY_CALL_CANCELLED);
      evts.emit(EVT_OUT_STREAM_ENDED);
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
    const tun = new Tunnel<T>();

    evts.setMaxListeners(0);

    const call: ChainServerDuplexStream<T, V> = {
      core,
      ctx,
      _tun: tun,
      cancelled: false,
      errOccurred: false,
      outStreamEnded: false,
      inStreamEnded: false,

      onMsgIn: (gate: TunnelGate<T>) => {
        tun.addGate(gate);
      },

      onInStreamEnded: (cb: () => void) => {
        evts.once(EVT_IN_STREAM_ENDED, cb);
      },

      sendMsg: (payload: V, cb?: () => void) => {
        if (call.errOccurred || call.cancelled || call.outStreamEnded) {
          return;
        }
        core.write(payload, () => {
          if (cb) {
            cb();
          }
          evts.emit(EVT_STREAM_MSG_WRITTEN, payload);
        });
      },

      sendErr: async (err: grpc.StatusObject) => {
        if (call.errOccurred || call.cancelled || call.outStreamEnded) {
          return;
        }
        call.errOccurred = true;
        const errorHandler = chainOpts.errorHandler;
        if (errorHandler) {
          call.err = await errorHandler(err, call as never);
        } else {
          call.err = err;
        }
        core.emit('error', call.err);
      },

      onMsgWritten: (cb: (payload: V) => void) => {
        evts.on(EVT_STREAM_MSG_WRITTEN, cb);
      },

      endOutStream: () => {
        if (call.errOccurred || call.cancelled || call.outStreamEnded) {
          return;
        }
        call.outStreamEnded = true;
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      },

      onOutStreamEnded: (cb: (err?: grpc.StatusObject | null) => void) => {
        evts.once(EVT_OUT_STREAM_ENDED, cb);
      },
    };

    core.once('end', () => {
      if (!call.inStreamEnded) {
        call.inStreamEnded = true;
        evts.emit(EVT_IN_STREAM_ENDED);
      }
    });

    core.once('error', (err) => {
      call.errOccurred = true;
      call.inStreamEnded = true;
      call.outStreamEnded = true;
      if (!call.err) {
        call.errOccurred = true;
        call.err = err;
      }
      if (!call.inStreamEnded) {
        call.inStreamEnded = true;
        evts.emit(EVT_IN_STREAM_ENDED);
      }
      if (!call.outStreamEnded) {
        call.outStreamEnded = true;
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      }
    });

    core.once('cancelled', () => {
      if (call.errOccurred || call.cancelled) {
        return;
      }
      call.cancelled = true;
      if (!call.inStreamEnded) {
        call.inStreamEnded = true;
        evts.emit(EVT_IN_STREAM_ENDED);
      }
      if (!call.outStreamEnded) {
        call.outStreamEnded = true;
        core.end();
        evts.emit(EVT_OUT_STREAM_ENDED);
      }
    });

    executeHandlers(call as never, 0, handlers, () => {
      core.on('data', (payload: T) => {
        tun.passPayload(payload);
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
