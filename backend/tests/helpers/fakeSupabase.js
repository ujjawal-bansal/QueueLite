/**
 * An in-memory stand-in for the Supabase client.
 *
 * Enough of PostgREST's query builder and of the three RPCs to drive the real
 * Express app through a whole clinic day. The RPC bodies mirror the SQL in
 * sql/schema.sql, so a change to one that is not made to the other shows up as
 * a failing test rather than as a surprise in production.
 */
const crypto = require('crypto');
const { getIstTodayUtcRange } = require('../../src/utils/time');

const createFakeSupabase = () => {
  const db = { clinics: [], tokens: [] };
  const counts = { select: 0, update: 0, rpc: 0 };
  // Lets a test reproduce the race where a token exists at the check and is
  // gone by the time the call-in runs.
  let vanishBeforeCallIn = false;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = 'select';
      this.patch = null;
      this.orderBy = null;
      this.limitCount = null;
      this.wantsSingle = false;
      this.wantsRows = false;
    }

    select() {
      this.wantsRows = true;
      return this;
    }

    update(patch) {
      this.operation = 'update';
      this.patch = patch;
      return this;
    }

    insert(row) {
      this.operation = 'insert';
      this.inserted = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...(this.table === 'tokens'
          ? {
              status: 'waiting',
              called_in_at: null,
              completed_at: null,
              heads_up_sent_at: null,
              turn_notified_at: null,
              queue_position: null,
              follow_up_due_on: null,
              follow_up_note: null,
              follow_up_status: null,
            }
          : {}),
        ...row,
      };
      return this;
    }

    eq(column, value) {
      if (column === 'token_day' && !tokenDayColumn) {
        this.missingColumn = 'token_day';
      }

      this.filters.push((row) => row[column] === value);
      return this;
    }

    neq(column, value) {
      this.filters.push((row) => row[column] !== value);
      return this;
    }

    // PostgREST's negation, as the history query uses it: .not(col, 'is', null).
    not(column, operator, value) {
      if (operator === 'is' && value === null) {
        this.filters.push(
          (row) => row[column] !== null && row[column] !== undefined
        );
      } else {
        this.filters.push((row) => row[column] !== value);
      }

      return this;
    }

    gte(column, value) {
      this.filters.push((row) => row[column] >= value);
      return this;
    }

    lt(column, value) {
      this.filters.push((row) => row[column] < value);
      return this;
    }

    lte(column, value) {
      this.filters.push((row) => row[column] <= value);
      return this;
    }

    in(column, values) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }

    order(column, { ascending = true } = {}) {
      this.orderBy = { column, ascending };
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    maybeSingle() {
      this.wantsSingle = true;
      return this;
    }

    run() {
      // Postgres reports an unknown column as 42703 whatever the statement is.
      if (this.missingColumn) {
        return {
          data: null,
          error: {
            code: '42703',
            message: `column tokens.${this.missingColumn} does not exist`,
          },
        };
      }

      if (this.operation === 'insert') {
        // Mirrors tokens_clinic_day_number_uniq. Without this the tests would
        // pass while the database refused the very rows they exercise.
        if (this.table === 'tokens') {
          if (collideOnceOnCreate) {
            collideOnceOnCreate = false;

            return {
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "tokens_clinic_day_number_uniq"',
              },
            };
          }

          const clash = db.tokens.some(
            (row) =>
              row.clinic_id === this.inserted.clinic_id &&
              row.token_day === this.inserted.token_day &&
              row.token_number === this.inserted.token_number
          );

          if (clash) {
            return {
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "tokens_clinic_day_number_uniq"',
              },
            };
          }
        }

        db[this.table].push(this.inserted);

        const copy = { ...this.inserted };

        return { data: this.wantsSingle ? copy : [copy], error: null };
      }

      let matched = db[this.table].filter((row) =>
        this.filters.every((predicate) => predicate(row))
      );

      if (this.operation === 'update') {
        counts.update += 1;
        matched.forEach((row) => Object.assign(row, this.patch));

        if (!this.wantsRows) {
          return { data: null, error: null };
        }
      } else {
        counts.select += 1;
      }

      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        const direction = ascending ? 1 : -1;
        matched = [...matched].sort(
          (a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * direction
        );
      }

      if (this.limitCount !== null) {
        matched = matched.slice(0, this.limitCount);
      }

      const copies = matched.map((row) => ({ ...row }));

      if (this.wantsSingle) {
        return { data: copies[0] || null, error: null };
      }

      return { data: copies, error: null };
    }

    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => this.run())
        .then(onFulfilled, onRejected);
    }
  }

  // Lets a test make the next token insert collide, the way two entries landing
  // together would.
  let collideOnceOnCreate = false;
  // Reproduces a database that has not had migration 006 applied.
  let tokenDayColumn = true;

  const rpcs = {
    // Mirrors public.call_in_token: closing out the previous patient and
    // calling in the next one happen together.
    call_in_token: ({ p_clinic_id, p_token_id }) => {
      const { start, end } = getIstTodayUtcRange();

      db.tokens
        .filter(
          (row) =>
            row.clinic_id === p_clinic_id &&
            row.status === 'in_progress' &&
            row.id !== p_token_id &&
            row.created_at >= start &&
            row.created_at < end
        )
        .forEach((row) => {
          row.status = 'done';
        });

      const target = vanishBeforeCallIn
        ? null
        : db.tokens.find(
            (row) => row.id === p_token_id && row.clinic_id === p_clinic_id
          );

      if (!target) {
        // What PostgREST actually returns when a plpgsql function declared
        // `returns public.tokens` finds nothing: a row of nulls, not null.
        // Returning null here would let a guard of `if (!token)` look correct
        // in tests while doing nothing in production.
        return {
          id: null,
          clinic_id: null,
          token_number: null,
          patient_name: null,
          patient_phone: null,
          status: null,
          created_at: null,
          called_in_at: null,
          completed_at: null,
          heads_up_sent_at: null,
          turn_notified_at: null,
          queue_position: null,
          follow_up_due_on: null,
          follow_up_note: null,
          follow_up_status: null,
        };
      }

      target.status = 'in_progress';
      target.called_in_at = new Date().toISOString();

      return { ...target };
    },

    // Mirrors public.claim_reminder: only the caller that flips the null wins.
    claim_reminder: ({ p_token_id, p_kind }) => {
      const column = p_kind === 'heads_up' ? 'heads_up_sent_at' : 'turn_notified_at';
      const target = db.tokens.find((row) => row.id === p_token_id);

      if (!target || target[column]) {
        return false;
      }

      target[column] = new Date().toISOString();

      return true;
    },
  };

  return {
    db,
    counts,
    setVanishBeforeCallIn: (value) => {
      vanishBeforeCallIn = value;
    },
    setCollideOnceOnCreate: (value) => {
      collideOnceOnCreate = value;
    },
    setTokenDayColumn: (value) => {
      tokenDayColumn = value;
    },
    from: (table) => new Query(table),
    rpc: async (name, args) => {
      counts.rpc += 1;

      if (!rpcs[name]) {
        return { data: null, error: new Error(`unknown rpc ${name}`) };
      }

      try {
        return { data: rpcs[name](args), error: null };
      } catch (error) {
        // PostgREST reports a constraint violation as an error object with the
        // Postgres SQLSTATE, not as a thrown exception.
        return { data: null, error: { message: error.message, code: error.code } };
      }
    },
  };
};

module.exports = { createFakeSupabase };
