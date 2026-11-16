import { runWithLogContext } from '@rustymotors/logging';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseProvider, LegacyMessage, type IDatabaseServices } from 'rusty-motors-shared';
import { loggerMock } from 'rusty-motors-shared/test';
import { isPersonaNameWellFormed, validatePersonaName } from '../src/persona/handlers/validatePersonaName.js';

const loginAddress = '10.111.111.11';

function registerStores(takenNames: string[]) {
    databaseProvider.register({
        auth: { hasSessionFromAddress: (customerId: number, address: string) => customerId === 654321 && address === loginAddress },
        persona: { isPersonaNameTaken: async (name: string) => takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase()) },
    } as unknown as IDatabaseServices);
}

function lengthPrefixed(text: string): Buffer {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(text.length, 0);
    return Buffer.concat([length, Buffer.from(text, 'latin1')]);
}

function checkRequest(customerId: number, name: string): LegacyMessage {
    const customer = Buffer.alloc(4);
    customer.writeUInt32BE(customerId, 0);
    const body = Buffer.concat([customer, lengthPrefixed(name), lengthPrefixed('Motor City')]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x533, 0);
    header.writeUInt16BE(12 + body.length, 2);
    header.writeUInt16BE(0x0101, 4);
    const message = new LegacyMessage();
    message._doDeserialize(Buffer.concat([header, body]));
    return message;
}

async function replyId(name: string, takenNames: string[] = [], remoteAddress = loginAddress): Promise<number> {
    registerStores(takenNames);
    const result = await runWithLogContext({ remoteAddress }, () =>
        validatePersonaName({ connectionId: 'test:8228', message: checkRequest(654321, name), log: loggerMock }),
    );
    expect(result.messages).toHaveLength(1);
    const reply = Buffer.from(result.messages[0]!.serialize());
    expect(reply.length).toBe(12);
    expect(reply.readUInt16BE(2)).toBe(12);
    return reply.readUInt16BE(0);
}

afterEach(() => databaseProvider.unregister());

describe('validatePersonaName', () => {
    it('answers 0x601 for an unused name', async () => {
        expect(await replyId('Marty')).toBe(0x601);
    });

    it('answers 0x20A for a name a live persona has, ignoring case', async () => {
        expect(await replyId('DR BROWN', ['Dr Brown'])).toBe(0x20a);
    });

    it('answers 0x635 for a name the client could not have produced', async () => {
        expect(await replyId('ElevenChars')).toBe(0x635);
    });

    it('answers 0x602 to a request from another address', async () => {
        expect(await replyId('Marty', [], '203.0.113.9')).toBe(0x602);
    });
});

describe('isPersonaNameWellFormed', () => {
    it('accepts 1 to 10 printable characters with inner spaces', () => {
        expect(['J', 'Dr Brown', 'Ten Chars!', '~{x}|'].map(isPersonaNameWellFormed)).toEqual([true, true, true, true]);
    });

    it('refuses empty, overlong, edge-spaced, and non-printable names', () => {
        expect(['', 'ElevenChars', ' Lead', 'Trail ', 'Tab\there', 'Caf' + String.fromCharCode(0xe9)].map(isPersonaNameWellFormed)).toEqual([
            false, false, false, false, false, false,
        ]);
    });
});
