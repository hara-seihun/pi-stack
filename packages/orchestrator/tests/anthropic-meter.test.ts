import {expect,test} from 'vitest';
import {anthropicMeterReadings} from '../src/extension/usage-logger.js';

test('provider overage is exhausted; malformed utilization and reset headers are not ledger values',()=>{
 const headers=(value:string,reset='')=>({'anthropic-ratelimit-unified-5h-utilization':value,'anthropic-ratelimit-unified-5h-reset':reset});
 for(const value of ['', ' ', 'NaN', 'Infinity', '-0.1', 'unknown'])expect(anthropicMeterReadings(headers(value),123)).toEqual([]);
 for(const [raw,expected] of [['0',0],['0.67',67],['1.01',100],['1e308',100]] as const){
  expect(anthropicMeterReadings(headers(raw,'invalid'),123)).toEqual([{meterId:'anthropic-5h',reading:{at:123,usedPercent:expected,resetAt:undefined}}]);
 }
});
