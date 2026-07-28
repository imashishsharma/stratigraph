import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { FactProtocolError, parseFact, readFacts, serializeFact } from '../src/facts/ndjson.js';
import type { Fact } from '../src/facts/types.js';

const nodeLine = JSON.stringify({
  v: 1,
  type: 'node',
  kind: 'class',
  fqn: 'com.example.tiny.domain.Greeting',
  name: 'Greeting',
  file: 'src/main/java/com/example/tiny/domain/Greeting.java',
  startLine: 3,
  endLine: 15,
});

describe('parseFact', () => {
  it('parses a node fact', () => {
    expect(parseFact(nodeLine)).toEqual({
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'com.example.tiny.domain.Greeting',
      name: 'Greeting',
      file: 'src/main/java/com/example/tiny/domain/Greeting.java',
      startLine: 3,
      endLine: 15,
    });
  });

  it('parses an edge fact and leaves confidence unset by default', () => {
    const fact = parseFact(
      JSON.stringify({
        v: 1,
        type: 'edge',
        kind: 'calls',
        src: { kind: 'method', fqn: 'a.B#c()' },
        dst: { kind: 'method', fqn: 'd.E#f()' },
        file: 'a/B.java',
        line: 12,
      }),
    );
    expect(fact).toMatchObject({ type: 'edge', kind: 'calls', line: 12 });
    expect(fact).not.toHaveProperty('confidence');
  });

  it('round-trips through serializeFact', () => {
    const fact = parseFact(nodeLine);
    expect(parseFact(serializeFact(fact))).toEqual(fact);
  });

  it('rejects an unknown protocol version', () => {
    expect(() => parseFact('{"v":2,"type":"file","path":"a","language":"java"}')).toThrow(
      /unsupported protocol version/,
    );
  });

  it('rejects an unknown node kind', () => {
    expect(() =>
      parseFact('{"v":1,"type":"node","kind":"widget","fqn":"a","name":"a"}'),
    ).toThrow(/"kind" must be one of/);
  });

  it('rejects an unknown edge kind', () => {
    expect(() =>
      parseFact(
        '{"v":1,"type":"edge","kind":"vibes","src":{"kind":"class","fqn":"a"},"dst":{"kind":"class","fqn":"b"}}',
      ),
    ).toThrow(/"kind" must be one of/);
  });

  it('rejects an edge with no destination', () => {
    expect(() =>
      parseFact('{"v":1,"type":"edge","kind":"calls","src":{"kind":"class","fqn":"a"}}'),
    ).toThrow(/"dst" is required/);
  });

  it('rejects an invalid confidence', () => {
    expect(() =>
      parseFact(
        '{"v":1,"type":"edge","kind":"calls","src":{"kind":"class","fqn":"a"},"dst":{"kind":"class","fqn":"b"},"confidence":"probably"}',
      ),
    ).toThrow(/"confidence" must be one of/);
  });

  it('rejects malformed JSON with the line number', () => {
    try {
      parseFact('{ not json', 7);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FactProtocolError);
      expect((err as FactProtocolError).line).toBe(7);
    }
  });

  it('rejects a negative line number', () => {
    expect(() =>
      parseFact(
        '{"v":1,"type":"edge","kind":"calls","src":{"kind":"class","fqn":"a"},"dst":{"kind":"class","fqn":"b"},"line":-1}',
      ),
    ).toThrow(/non-negative integer/);
  });
});

describe('readFacts', () => {
  it('reads a stream, skipping blank lines', async () => {
    const stream = Readable.from(
      [
        '{"v":1,"type":"meta","extractor":"java","extractorVersion":"0.0.0"}',
        '',
        nodeLine,
        '   ',
        '{"v":1,"type":"diagnostic","level":"warn","message":"unresolved type"}',
        '',
      ].join('\n'),
    );
    const facts: Fact[] = [];
    for await (const fact of readFacts(stream)) facts.push(fact);
    expect(facts.map((f) => f.type)).toEqual(['meta', 'node', 'diagnostic']);
  });

  it('fails loudly on a bad line rather than skipping it', async () => {
    const stream = Readable.from([nodeLine, '{"v":1,"type":"nope"}'].join('\n'));
    const read = async () => {
      for await (const _ of readFacts(stream)) void _;
    };
    await expect(read()).rejects.toThrow(/line 2: unknown fact type/);
  });
});
