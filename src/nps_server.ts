// mcos is a game server, written from scratch, for an old game
// Copyright (C) <2017>  <Drazi Crendraven>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import * as Sentry from '@sentry/node';
import {
    Gateway,
    initializeServiceRegistry,
    readAccountServiceSettings,
    readSiteLoginCheckSettings,
    startAccountService,
    useSiteLoginCheck,
} from 'rusty-motors-gateway';
import {
    getServerLogger,
    verifyLegacyCipherSupport,
    getServerConfiguration,
    getGameRoomPorts,
    ServerLogger,
    databaseProvider,
} from 'rusty-motors-shared';
import { createDatabaseServices } from 'rusty-motors-database';

function main() {
    const coreLogger = getServerLogger('npx/core');
    try {
        verifyLegacyCipherSupport();

        // Initialize database services from environment (12-factor app pattern)
        const databaseUrl = process.env['DATABASE_URL'];
        const sqlitePath = process.env['SQLITE_PATH'] ?? 'data/lotus.db';

        if (!databaseUrl) {
            coreLogger.error('DATABASE_URL environment variable is required');
            process.exit(1);
        }

        // Create and register injectable database services
        const dbServices = createDatabaseServices({
            postgresUrl: databaseUrl,
            sqlitePath,
            logger: coreLogger,
        });
        databaseProvider.register(dbServices);

        // Verify connection
        if (!dbServices.auth.isDatabaseConnected) {
            coreLogger.error('Database connection failed. Exiting.');
            process.exit(1);
        }

        coreLogger.info('Database services initialized');

        // Initialize the service registry with default services
        initializeServiceRegistry();
        coreLogger.info('Service registry initialized');
    } catch (err) {
        coreLogger.error("Error in core server", { err });
        process.exitCode = 1;
        return;
    }

    try {
        const config = getServerConfiguration();
        const sanitizedConfig = {
            ...config,
            privateKeyFile: '[REDACTED]',
        };
        coreLogger.debug(
            `Pre-flight checks passed. Starting server with config: ${JSON.stringify(sanitizedConfig)}`,
        );

        const tcpListeningPortList = [
            6660, 7003, 8228, 8226, 8227, ...getGameRoomPorts(), 10001, 43200, 43300, 43400, 53303,
        ];

        const udpListeningPortList = [
            6660, 7003, 8228, 8226, 8227, ...getGameRoomPorts(), 10001, 43200, 43300, 43400, 53303,
        ];

        const gatewayServer = new Gateway({
            config,
            tcpListeningPortList,
            udpListeningPortList,
        });

        coreLogger.info('Starting server');
        gatewayServer.start();

        // Ammolite's check of a login: with its settings file AuthLogin asks the site, and the server's own passwords
        // are no longer read.
        const siteLoginCheckSettingsPath = process.env['SITE_LOGIN_CHECK_SETTINGS'];
        if (siteLoginCheckSettingsPath) {
            const siteLoginCheckSettings = readSiteLoginCheckSettings(siteLoginCheckSettingsPath);
            useSiteLoginCheck(siteLoginCheckSettings);
            coreLogger.info(`AuthLogin checks logins with the site at ${new URL(siteLoginCheckSettings.checkUrl).host}`);
        } else {
            coreLogger.info('AuthLogin checks the server\'s own logins: SITE_LOGIN_CHECK_SETTINGS is not set');
        }

        // ammolite's account service: the link script writes its settings file; without one the
        // server is not linked to the portal.
        const accountServiceSettingsPath = process.env['ACCOUNT_SERVICE_SETTINGS'];
        const accountServiceSettings = accountServiceSettingsPath ? readAccountServiceSettings(accountServiceSettingsPath) : undefined;
        if (accountServiceSettings) {
            startAccountService(accountServiceSettings, getServerLogger('accountService'));
        } else {
            coreLogger.info(`Account service off: ${accountServiceSettingsPath ? `${accountServiceSettingsPath} does not exist` : 'ACCOUNT_SERVICE_SETTINGS is not set'}`);
        }
    } catch (err) {
        return captureAndLogErrorAndSetNotZeroExitCode(err, coreLogger);
    }
}

main();
function captureAndLogErrorAndSetNotZeroExitCode(err: unknown, coreLogger: ServerLogger) {
    Sentry.captureException(err);
    coreLogger.error("Error in core server", { err });
    process.exitCode = 1;
    return;
}

