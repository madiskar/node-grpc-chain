import grpc, { ServerWritableStream, ServerWriteableStream } from 'grpc';
import * as jspb from 'google-protobuf';
import { GRPCError } from './error';
import { Context } from './context';
import { streamToRx } from 'rxjs-stream';
import { takeUntil, catchError } from 'rxjs/operators';
import { Observable, fromEvent } from 'rxjs';

/**
 * Incoming stream to which we attach an RX Observable.
 */
export interface ObservableClientStream<T extends jspb.Message> {
  source: Observable<T>;
}

/**
 * Intersection type for `ServerDuplexStream` that adds RX support.
 */
export type ServerDuplexStreamRx<T extends jspb.Message, V extends jspb.Message> = grpc.ServerDuplexStream<T, V> &
  ObservableClientStream<T>;

/**
 * Intersection type for `ServerReadableStream` that adds RX support.
 */
export type ServerReadableStreamRx<T extends jspb.Message> = grpc.ServerReadableStream<T> & ObservableClientStream<T>;

/**
 * Handler function type for regular, unary RPCs.
 */
export type UnaryCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: grpc.ServerUnaryCall<T>,
  ctx: Context,
) => Promise<V> | V;

/**
 * Handler function type for client-streaming RPCs, using RX Observables.
 */
export type ClientStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ServerReadableStreamRx<T>,
  ctx: Context,
) => Promise<V> | V;

/**
 * Handler function type for server-streaming RPCs, using RX Observables.
 */
export type ServerStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: grpc.ServerWritableStream<T>,
  ctx: Context,
) => Promise<Observable<V>> | Observable<V>;

/**
 * Handler function type for bidi-streaming RPCs, using RX Observables.
 */
export type BidiStreamingCallHandler<T extends jspb.Message, V extends jspb.Message> = (
  call: ServerDuplexStreamRx<T, V>,
  ctx: Context,
) => Promise<Observable<V>> | Observable<V>;

/**
 * Union type for all our call handlers.
 */
export type CallHandler<T extends jspb.Message, V extends jspb.Message> =
  | UnaryCallHandler<T, V>
  | ClientStreamingCallHandler<T, V>
  | ServerStreamingCallHandler<T, V>
  | BidiStreamingCallHandler<T, V>;

/**
 * Union type that describes the initial gRPC call, as provided
 * by `grpc` library.
 */
export type InitialServiceCall<T extends jspb.Message, V extends jspb.Message> =
  | grpc.ServerUnaryCall<T>
  | grpc.ServerDuplexStream<T, V>
  | grpc.ServerReadableStream<T>
  | grpc.ServerWritableStream<T>;

/**
 * Union type that describes our internal gRPC call, where have attached
 * some additional information to some call types.
 */
export type ServiceCall<T extends jspb.Message, V extends jspb.Message> =
  | grpc.ServerUnaryCall<T>
  | ServerDuplexStreamRx<T, V>
  | ServerReadableStreamRx<T>
  | grpc.ServerWritableStream<T>;

/**
 * Represent an action to execute the next handler in the call chain.
 */
export type NextFunction = (call: ServiceCall<jspb.Message, jspb.Message>, ctx: Context) => void;

/**
 * An intermediary call handler.
 */
export type Interceptor<T extends jspb.Message, V extends jspb.Message> = (
  call: ServiceCall<T, V>,
  ctx: Context,
  next: NextFunction,
) => Promise<void> | void;

/**
 * Union type for all call handlers.
 */
export type ChainableHandler<T extends jspb.Message, V extends jspb.Message> = CallHandler<T, V> | Interceptor<T, V>;

/**
 * Custom error handler.
 */
export type ServiceErrorHandler = (
  err: Error,
  call: InitialServiceCall<jspb.Message, jspb.Message>,
  ctx: Context,
) => Promise<GRPCError> | GRPCError;

/**
 * Chain init options.
 */
export interface ChainOptions {
  errorHandler?: ServiceErrorHandler;
  requestIdLength?: number;
}

type T<K> = K extends grpc.handleCall<infer T, unknown> ? T : never;
type V<K> = K extends grpc.handleCall<unknown, infer V> ? V : never;

/**
 * Call handling chain.
 */
export type Chain = <K extends grpc.handleCall<T<K>, V<K>>>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  ...handlers: ChainableHandler<T<K>, V<K>>[]
) => K;

/**
 * Default error handler.
 *
 * @param err `Error` to handle
 */
export function defaultErrorHandler(err: Error): GRPCError {
  let grpcErr: GRPCError;
  if (err instanceof GRPCError) {
    grpcErr = err;
  } else {
    grpcErr = new GRPCError('Internal error', grpc.status.INTERNAL);
  }
  return grpcErr;
}

async function emitObservable<T extends jspb.Message, V extends jspb.Message>(
  call: ServerDuplexStreamRx<T, V> | ServerWriteableStream<T>,
  source: Observable<V>,
  ctx: Context,
) {
  await source
    .pipe(
      takeUntil(fromEvent(call, 'cancelled')),
      catchError((err) => {
        throw err;
      }),
    )
    .forEach((message) => {
      ctx._streamMsgOut(message);
      call.write(message);
    });
  return source;
}

function consumeBidiServerObservable<T extends jspb.Message, V extends jspb.Message>(
  handler: BidiStreamingCallHandler<T, V>,
): BidiStreamingCallHandler<T, V> {
  return async (call: ServerDuplexStreamRx<T, V>, ctx: Context): Promise<Observable<V>> => {
    const source = await handler(call, ctx);
    return await emitObservable(call, source, ctx);
  };
}

function consumeServerObservable<T extends jspb.Message, V extends jspb.Message>(
  handler: ServerStreamingCallHandler<T, V>,
): ServerStreamingCallHandler<T, V> {
  return async (call: ServerWritableStream<T>, ctx: Context): Promise<Observable<V>> => {
    const source = await handler(call, ctx);
    return await emitObservable(call, source, ctx);
  };
}

function wrapBidiStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handler: BidiStreamingCallHandler<T, V>,
  chainOpts?: ChainOptions,
): grpc.handleBidiStreamingCall<T, V> {
  return async (call: grpc.ServerDuplexStream<T, V>): Promise<void> => {
    const ctx = new Context({
      method,
      reqIdLength: chainOpts?.requestIdLength ?? 32,
    });
    const callRx = call as ServerDuplexStreamRx<T, V>;
    callRx.source = streamToRx(call);

    try {
      await handler(callRx, ctx);
    } catch (err) {
      const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
      call.emit('error', (await errorHandler(err, call, ctx)).asServiceError());
    } finally {
      call.end();
      ctx._close();
    }
  };
}

function wrapServerStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handler: ServerStreamingCallHandler<T, V>,
  chainOpts?: ChainOptions,
): grpc.handleServerStreamingCall<T, V> {
  return async (call: grpc.ServerWritableStream<T>): Promise<void> => {
    const ctx = new Context({
      method,
      reqIdLength: chainOpts?.requestIdLength ?? 32,
    });

    try {
      await handler(call, ctx);
    } catch (err) {
      const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
      call.emit('error', (await errorHandler(err, call, ctx)).asServiceError());
    } finally {
      call.end();
      ctx._close();
    }
  };
}

function wrapClientStreamingCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handler: ClientStreamingCallHandler<T, V>,
  chainOpts?: ChainOptions,
): grpc.handleClientStreamingCall<T, V> {
  return async (call: grpc.ServerReadableStream<T>, callback: grpc.sendUnaryData<V>): Promise<void> => {
    const ctx = new Context({
      method,
      reqIdLength: chainOpts?.requestIdLength ?? 32,
    });
    const callRx = call as ServerReadableStreamRx<T>;
    callRx.source = streamToRx(call);

    try {
      const resp = await handler(callRx, ctx);
      ctx._setRespPayload(resp);
      ctx._setRespCode(grpc.status.OK);
      callback(null, resp);
    } catch (err) {
      const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
      callback((await errorHandler(err, call, ctx)).asServiceError(), null);
    } finally {
      ctx._close();
    }
  };
}

function wrapUnaryCall<T extends jspb.Message, V extends jspb.Message>(
  method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
  handler: UnaryCallHandler<T, V>,
  chainOpts?: ChainOptions,
): grpc.handleUnaryCall<T, V> {
  return async (call: grpc.ServerUnaryCall<T>, callback: grpc.sendUnaryData<V>): Promise<void> => {
    const ctx = new Context({
      method,
      reqIdLength: chainOpts?.requestIdLength ?? 32,
    });

    try {
      const resp = await handler(call, ctx);
      ctx._setRespPayload(resp);
      ctx._setRespCode(grpc.status.OK);
      callback(null, resp);
    } catch (err) {
      const errorHandler = chainOpts?.errorHandler ?? defaultErrorHandler;
      callback((await errorHandler(err, call, ctx)).asServiceError(), null);
    } finally {
      ctx._close();
    }
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
    method: grpc.MethodDefinition<jspb.Message, jspb.Message>,
    ...handlers: ChainableHandler<T<K>, V<K>>[]
  ): K {
    // Last handler in the chain should be CallHandler
    let callHandler: ChainableHandler<T<K>, V<K>> = handlers[handlers.length - 1];
    if (method.responseStream && method.requestStream) {
      // If our server is expected to respond with a stream, we wrap these handler
      // functions in a
      callHandler = consumeBidiServerObservable(callHandler as BidiStreamingCallHandler<T<K>, V<K>>);
    } else if (method.responseStream) {
      callHandler = consumeServerObservable(callHandler as ServerStreamingCallHandler<T<K>, V<K>>);
    }

    // Loop over remaining handlers, which should be Interceptors. This results in
    // a chain, where each Interceptor will have to call `next(call, ctx)` in order to
    // to continue to the next part of the chain. Eventually the `CallHandler` will be
    // executed.
    for (let i = handlers.length - 2; i > -1; i--) {
      const nextHandler = callHandler;
      callHandler = (call: ServiceCall<T<K>, V<K>>, ctx: Context) =>
        (handlers[i] as Interceptor<T<K>, V<K>>)(call, ctx, nextHandler as NextFunction);
    }

    // Wrap the whole chain in a gRPC compatible function. These functions also perform exception
    // catching as well as some resource closing
    if (method.responseStream && method.requestStream) {
      return wrapBidiStreamingCall(method, callHandler as BidiStreamingCallHandler<T<K>, V<K>>, opts) as K;
    } else if (method.responseStream) {
      return wrapServerStreamingCall(method, callHandler as ServerStreamingCallHandler<T<K>, V<K>>, opts) as K;
    } else if (method.requestStream) {
      return wrapClientStreamingCall(method, callHandler as ClientStreamingCallHandler<T<K>, V<K>>, opts) as K;
    } else {
      return wrapUnaryCall(method, callHandler as UnaryCallHandler<T<K>, V<K>>, opts) as K;
    }
  };

  return chain;
}
