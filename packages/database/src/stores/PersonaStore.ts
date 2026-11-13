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

import { randomInt } from "node:crypto";
import * as pg from "@databases/pg";
import { type ConnectionPool, type ConnectionPoolConfig, type SQLQuery, sql } from "@databases/pg";
import { type IPersonaStore, maximumPersonasPerCustomer, type PersonaCar, type PersonaOptions, type PersonaPhysical, type PersonaPlayer, type PersonaSummary, starterCash } from "rusty-motors-shared";

type createConnectionPool = (
    connectionConfig?: string | ConnectionPoolConfig | undefined,
) => ConnectionPool;

const playerType = 3;
const deletedPlayerType = 4;
const uniqueViolation = "23505";
const carNumberCount = 6;

type PersonaRow = {
    profile_id: number;
    customer_id: number;
    profile_name: string;
    shard_id: number;
    create_stamp: number;
};

type PlayerRow = {
    player_id: number;
    customer_id: number;
    persona: string;
    bank_balance: number;
    cars_owned: number;
    lp_code: number;
    lp_text: string | null;
    car_info_setting: number | null;
    car_num1: string;
    car_num2: string;
    car_num3: string;
    car_num4: string;
    car_num5: string;
    car_num6: string;
    description: string;
    body_type: number;
    hair_color: number;
    skin_color: number;
    shirt_color: number;
    pants_color: number;
};

function playerFromRow(row: PlayerRow): PersonaPlayer {
    return {
        personaId: row.player_id,
        customerId: row.customer_id,
        name: row.persona,
        bankBalance: row.bank_balance,
        carsOwned: row.cars_owned,
        plateCode: row.lp_code,
        plateText: row.lp_text ?? "",
        carInfoSetting: row.car_info_setting ?? 0,
        carNumbers: [row.car_num1, row.car_num2, row.car_num3, row.car_num4, row.car_num5, row.car_num6],
        description: row.description,
        physical: {
            bodyType: row.body_type,
            hairColor: row.hair_color,
            skinColor: row.skin_color,
            shirtColor: row.shirt_color,
            pantsColor: row.pants_color,
        },
    };
}

function personaFromRow(row: PersonaRow): PersonaSummary {
    return {
        personaId: row.profile_id,
        customerId: row.customer_id,
        name: row.profile_name,
        shardId: row.shard_id,
        createStamp: row.create_stamp,
    };
}

/**
 * Personas in PostgreSQL: a profile row and a player row each, sharing the id
 * (see migration 0042-storePersonas).
 */
export class PersonaStore implements IPersonaStore {
    private pool: ConnectionPool;

    constructor(postgresUrl: string) {
        if (!postgresUrl) {
            throw new Error("PersonaStore needs the PostgreSQL URL (DATABASE_URL)");
        }
        this.pool = (pg.default as unknown as createConnectionPool)({
            connectionString: postgresUrl,
            bigIntMode: "number",
        });
    }

    async listPersonas(customerId: number): Promise<PersonaSummary[]> {
        const rows = (await this.pool.query(sql`
            SELECT profile.profile_id, profile.customer_id, profile.profile_name, profile.shard_id, profile.create_stamp
            FROM profile JOIN player ON player.player_id = profile.profile_id
            WHERE profile.customer_id = ${customerId} AND player.player_type_id <> ${deletedPlayerType}
            ORDER BY profile.create_stamp, profile.profile_id`)) as PersonaRow[];
        return rows.map(personaFromRow);
    }

    async findPersona(personaId: number): Promise<PersonaSummary | undefined> {
        const rows = (await this.pool.query(sql`
            SELECT profile.profile_id, profile.customer_id, profile.profile_name, profile.shard_id, profile.create_stamp
            FROM profile JOIN player ON player.player_id = profile.profile_id
            WHERE profile.profile_id = ${personaId} AND player.player_type_id <> ${deletedPlayerType}`)) as PersonaRow[];
        return rows.map(personaFromRow)[0];
    }

    async createPersona(customerId: number, name: string, shardId: number): Promise<PersonaSummary | undefined> {
        try {
            const rows = (await this.pool.tx(async (transaction) => {
                const [{ id }] = (await transaction.query(sql`SELECT nextval('persona_id_seq')::integer AS id`)) as [{ id: number }];
                await transaction.query(sql`
                    INSERT INTO player (player_id, customer_id, player_type_id, bank_balance, num_cars_owned, driver_style, lp_code,
                        car_num1, car_num2, car_num3, car_num4, car_num5, car_num6, persona)
                    VALUES (${id}, ${customerId}, ${playerType}, ${starterCash}, 0, 0, 0, '', '', '', '', '', '', ${name})`);
                return transaction.query(sql`
                    INSERT INTO profile (customer_id, profile_name, profile_id, shard_id)
                    VALUES (${customerId}, ${name}, ${id}, ${shardId})
                    RETURNING profile_id, customer_id, profile_name, shard_id, create_stamp`);
            })) as PersonaRow[];
            return rows.map(personaFromRow)[0];
        } catch (error) {
            if ((error as { code?: string }).code === uniqueViolation) {
                return undefined;
            }
            throw error;
        }
    }

    async deletePersona(customerId: number, personaId: number): Promise<boolean> {
        const nameSuffix = `~${randomInt(100000, 1000000)}`;
        return this.pool.tx(async (transaction) => {
            const deleted = await transaction.query(sql`
                UPDATE player SET player_type_id = ${deletedPlayerType}, persona = persona || ${nameSuffix}
                WHERE player_id = ${personaId} AND customer_id = ${customerId} AND player_type_id <> ${deletedPlayerType}
                RETURNING persona`);
            if (deleted.length === 0) {
                return false;
            }
            await transaction.query(sql`
                UPDATE profile SET profile_name = ${(deleted[0] as { persona: string }).persona} WHERE profile_id = ${personaId}`);
            return true;
        });
    }

    async findPlayer(personaId: number): Promise<PersonaPlayer | undefined> {
        const rows = (await this.pool.query(sql`
            SELECT player.player_id, player.customer_id, player.persona, player.bank_balance,
                (SELECT count(*)::integer FROM vehicle JOIN part ON part.part_id = vehicle.vehicle_id
                    WHERE part.owner_id = player.player_id) AS cars_owned,
                player.lp_code, player.lp_text, player.car_info_setting, player.car_num1, player.car_num2,
                player.car_num3, player.car_num4, player.car_num5, player.car_num6, player.description,
                player.body_type, player.hair_color, player.skin_color, player.shirt_color, player.pants_color
            FROM player
            WHERE player.player_id = ${personaId} AND player.player_type_id = ${playerType}`)) as PlayerRow[];
        return rows.map(playerFromRow)[0];
    }

    async setOptions(personaId: number, options: PersonaOptions): Promise<void> {
        if (options.carNumbers.length !== carNumberCount) {
            throw new Error(`Options carry ${options.carNumbers.length} car numbers, not ${carNumberCount}`);
        }
        const [carNumber1, carNumber2, carNumber3, carNumber4, carNumber5, carNumber6] = options.carNumbers;
        await this.updateLivePersona(personaId, sql`
            lp_code = ${options.plateCode}, lp_text = ${options.plateText}, car_info_setting = ${options.carInfoSetting},
            car_num1 = ${carNumber1}, car_num2 = ${carNumber2}, car_num3 = ${carNumber3},
            car_num4 = ${carNumber4}, car_num5 = ${carNumber5}, car_num6 = ${carNumber6}`);
    }

    async setPhysical(personaId: number, physical: PersonaPhysical): Promise<void> {
        await this.updateLivePersona(personaId, sql`
            body_type = ${physical.bodyType}, hair_color = ${physical.hairColor}, skin_color = ${physical.skinColor},
            shirt_color = ${physical.shirtColor}, pants_color = ${physical.pantsColor}`);
    }

    async setDescription(personaId: number, description: string): Promise<void> {
        await this.updateLivePersona(personaId, sql`description = ${description}`);
    }

    private async updateLivePersona(personaId: number, assignments: SQLQuery): Promise<void> {
        const updated = await this.pool.query(sql`
            UPDATE player SET ${assignments}
            WHERE player_id = ${personaId} AND player_type_id = ${playerType}
            RETURNING player_id`);
        if (updated.length !== 1) {
            throw new Error(`There is no live persona ${personaId} to update`);
        }
    }

    async movePersonas(personaNames: string[], fromCustomerId: number, toCustomerId: number): Promise<{ moved: string[] } | { refusal: string }> {
        const wanted = personaNames.map((name) => name.toLowerCase());
        return this.pool.tx(async (transaction) => {
            const found = (await transaction.query(sql`
                SELECT player.player_id, player.persona FROM player
                JOIN profile ON profile.profile_id = player.player_id AND profile.customer_id = player.customer_id
                WHERE player.customer_id = ${fromCustomerId} AND player.player_type_id <> ${deletedPlayerType}
                    AND lower(player.persona) = ANY(${wanted})
                FOR UPDATE OF player, profile`)) as { player_id: number; persona: string }[];
            const missing = personaNames.filter((name) => !found.some((row) => row.persona.toLowerCase() === name.toLowerCase()));
            if (missing.length > 0) {
                return { refusal: `not a persona of that login: ${missing.join(", ")}` };
            }
            const [{ held }] = (await transaction.query(sql`
                SELECT count(*)::integer AS held FROM player
                WHERE customer_id = ${toCustomerId} AND player_type_id <> ${deletedPlayerType}`)) as [{ held: number }];
            if (held + found.length > maximumPersonasPerCustomer) {
                return { refusal: `the login would hold ${held + found.length} personas; the game shows at most ${maximumPersonasPerCustomer}` };
            }
            const ids = found.map((row) => row.player_id);
            await transaction.query(sql`UPDATE player SET customer_id = ${toCustomerId} WHERE player_id = ANY(${ids})`);
            await transaction.query(sql`UPDATE profile SET customer_id = ${toCustomerId} WHERE profile_id = ANY(${ids})`);
            return { moved: found.map((row) => row.persona) };
        });
    }

    async listPersonasOfLogins(loginNames: string[]): Promise<{ loginName: string; personaName: string; car: PersonaCar | null }[]> {
        const rows = (await this.pool.query(sql`
            SELECT login.login_name, player.persona, car.model_id, car.model_year, car.brand, car.model
            FROM login
            JOIN profile ON profile.customer_id = login.customer_id
            JOIN player ON player.player_id = profile.profile_id
            LEFT JOIN LATERAL (
                SELECT model.model_id, EXTRACT(YEAR FROM branded_part.mfg_date)::integer AS model_year, brand.brand,
                    model.e_model AS model
                FROM part
                JOIN vehicle ON vehicle.vehicle_id = part.part_id
                JOIN branded_part ON branded_part.branded_part_id = part.branded_part_id
                JOIN model ON model.model_id = branded_part.model_id
                JOIN brand ON brand.brand_id = model.brand_id
                WHERE part.owner_id = player.player_id
                ORDER BY part.part_id
                LIMIT 1
            ) car ON true
            WHERE login.login_name = ANY(${loginNames}) AND player.player_type_id = ${playerType}
            ORDER BY login.login_name, profile.create_stamp, profile.profile_id`)) as {
                login_name: string;
                persona: string;
                model_id: number | null;
                model_year: number | null;
                brand: string | null;
                model: string | null;
            }[];
        return rows.map((row) => {
            if (row.model_id === null) {
                return { loginName: row.login_name, personaName: row.persona, car: null };
            }
            if (row.model_year === null || row.brand === null || row.model === null) {
                throw new Error(`Car model ${row.model_id} of persona ${row.persona} has no year, brand or English name`);
            }
            return { loginName: row.login_name, personaName: row.persona, car: { modelYear: row.model_year, brand: row.brand, model: row.model } };
        });
    }

    async isPersonaNameTaken(name: string): Promise<boolean> {
        const rows = await this.pool.query(sql`
            SELECT 1 FROM player
            WHERE lower(persona) = lower(${name}) AND player_type_id <> ${deletedPlayerType}
            LIMIT 1`);
        return rows.length > 0;
    }
}
