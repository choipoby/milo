import dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';

// @ts-ignore
import {Platform, WS} from '../dist/milo.node';

import mergeCustomConfig from './merge-custom-config';
mergeCustomConfig(Platform);

import autobahn from './runner';
import getAgent from './runner/get-agent';

const updateReport = process.env.UPDATE_REPORT === 'true';
const Class = process.env.MILO === 'true' ? WS : WebSocket

autobahn(Class, {
    updateReport,
    port: 9001,
    agent: getAgent(),
    Platform,
});

