import { pool, initDatabase } from './db.js';

async function fetchRealHistory(base: string, quote: string): Promise<any[]> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 35); // 多取几天以补齐周末

    const endStr = endDate.toISOString().split('T')[0];
    const startStr = startDate.toISOString().split('T')[0];

    const url = `https://api.frankfurter.app/${startStr}..${endStr}?from=${base}&to=${quote}`;
    console.log(`   Fetching ${base}/${quote} history from Frankfurter API...`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json() as any;
    if (data && data.rates) {
      const history = [];
      const dates = Object.keys(data.rates).sort();
      for (const d of dates) {
        const rateVal = data.rates[d][quote];
        if (rateVal !== undefined) {
          history.push({
            date: d,
            rate: Number(rateVal.toFixed(4))
          });
        }
      }
      return history.slice(-30);
    }
  } catch (err) {
    console.error(`   ❌ Failed to fetch ${base}/${quote} history:`, err);
  }
  return [];
}

export async function syncFxHistory() {
  console.log('🔄 Starting Exchange Rate History Sync worker...');
  await initDatabase();
  const client = await pool.connect();
  try {
    const pairs = [
      { base: 'USD', quote: 'CNY' },
      { base: 'USD', quote: 'MYR' },
      { base: 'CNY', quote: 'MYR' }
    ];

    for (const pair of pairs) {
      const historyData = await fetchRealHistory(pair.base, pair.quote);
      if (historyData.length > 0) {
        const pairStr = `${pair.base}/${pair.quote}`;
        await client.query(
          `INSERT INTO fx_history (pair, history_data, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (pair) DO UPDATE SET
             history_data = EXCLUDED.history_data,
             updated_at = CURRENT_TIMESTAMP`,
          [pairStr, JSON.stringify(historyData)]
        );
        console.log(`   ✅ Synced ${pairStr} successfully with ${historyData.length} records.`);
      }
    }
    console.log('🎉 Exchange Rate History Sync finished successfully.');
  } catch (error) {
    console.error('❌ Sync fx history failed:', error);
  } finally {
    client.release();
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  syncFxHistory()
    .then(() => {
      pool.end();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      pool.end();
      process.exit(1);
    });
}
