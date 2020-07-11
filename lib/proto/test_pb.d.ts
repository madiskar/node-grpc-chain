// package: test
// file: test.proto

/* tslint:disable */
/* eslint-disable */

import * as jspb from "google-protobuf";

export class TestMessage extends jspb.Message { 
    getText(): string;
    setText(value: string): TestMessage;


    serializeBinary(): Uint8Array;
    toObject(includeInstance?: boolean): TestMessage.AsObject;
    static toObject(includeInstance: boolean, msg: TestMessage): TestMessage.AsObject;
    static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
    static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
    static serializeBinaryToWriter(message: TestMessage, writer: jspb.BinaryWriter): void;
    static deserializeBinary(bytes: Uint8Array): TestMessage;
    static deserializeBinaryFromReader(message: TestMessage, reader: jspb.BinaryReader): TestMessage;
}

export namespace TestMessage {
    export type AsObject = {
        text: string,
    }
}

export class AnotherTestMessage extends jspb.Message { 
    getEmail(): string;
    setEmail(value: string): AnotherTestMessage;


    serializeBinary(): Uint8Array;
    toObject(includeInstance?: boolean): AnotherTestMessage.AsObject;
    static toObject(includeInstance: boolean, msg: AnotherTestMessage): AnotherTestMessage.AsObject;
    static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
    static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
    static serializeBinaryToWriter(message: AnotherTestMessage, writer: jspb.BinaryWriter): void;
    static deserializeBinary(bytes: Uint8Array): AnotherTestMessage;
    static deserializeBinaryFromReader(message: AnotherTestMessage, reader: jspb.BinaryReader): AnotherTestMessage;
}

export namespace AnotherTestMessage {
    export type AsObject = {
        email: string,
    }
}
