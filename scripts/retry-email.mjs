import {service} from '../src/core/service.js';
await service().retryFailed();
console.log('Retried known failed and pending messages. Unknown or interrupted sends were left unchanged; check provider logs before any manual reconciliation.');
