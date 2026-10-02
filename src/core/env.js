import {existsSync} from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
