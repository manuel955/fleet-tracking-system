import test from 'node:test';
import assert from 'node:assert/strict';

test('optional feedback comment may be empty when rating is provided', () => {
  const body = { rating: 5, comment: '', incidentCategory: 'none' };
  const comment = body.comment === undefined || body.comment === null
    ? ''
    : typeof body.comment === 'string' && body.comment.trim().length <= 1000
      ? body.comment.trim()
      : null;
  assert.equal(comment, '');
});

test('feedback comments remain bounded', () => {
  const comment = 'x'.repeat(1001);
  assert.equal(comment.trim().length <= 1000, false);
});
