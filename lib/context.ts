import grpc from 'grpc';
import * as jspb from 'google-protobuf';
import { EventEmitter } from 'events';
import { genRandomString } from './crypto';

/**
 * Context of a specific call.
 */
export class Context {
  public readonly method: grpc.MethodDefinition<jspb.Message, jspb.Message>;
  public readonly reqId: string;

  /**
   * Request scoped variables
   */
  public locals: { [key: string]: unknown } = {};
  public respPayload?: jspb.Message;
  public respCode?: grpc.status;

  private emitter: EventEmitter = new EventEmitter();
  private evtFinish = 'finish';
  private evtStreamMsgOut = 'stream_msg_out';

  constructor(opts: { method: grpc.MethodDefinition<jspb.Message, jspb.Message>; reqIdLength: number }) {
    this.method = opts.method;
    this.reqId = genRandomString(opts.reqIdLength);
  }

  public _setRespPayload(payload: jspb.Message): void {
    this.respPayload = payload;
  }

  public _setRespCode(code: grpc.status): void {
    this.respCode = code;
  }

  public _close(): void {
    this.emitter.emit(this.evtFinish);
    this.emitter.removeAllListeners();
  }

  public _onCallFinish(listener: () => Promise<void> | void): void {
    this.emitter.once(this.evtFinish, listener);
  }

  public _streamMsgOut(msg: jspb.Message): void {
    this.emitter.emit(this.evtStreamMsgOut, msg);
  }

  public onStreamMsgOut(listener: (msg: jspb.Message) => Promise<void> | void): void {
    this.emitter.on(this.evtStreamMsgOut, listener);
  }

  public offStreamMsgOut(listener: (msg: jspb.Message) => Promise<void> | void): void {
    this.emitter.off(this.evtStreamMsgOut, listener);
  }
}
