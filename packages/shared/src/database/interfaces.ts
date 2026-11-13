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

import type {
    ConnectionRecord,
    IRunningServerInfo,
    UserRecordMini,
} from "../types.js";
import type { UserInfo } from "../UserData.js";

/**
 * Session store interface - manages runtime connection/session state
 * This is for in-memory session tracking during server runtime
 */
export interface ISessionStore {
    updateSessionKey(
        customerId: number,
        sessionKey: string,
        contextId: string,
        connectionId: string,
    ): Promise<void>;

    fetchSessionKeyByCustomerId(customerId: number): Promise<ConnectionRecord>;

    fetchSessionKeyByConnectionId(connectionId: string): Promise<ConnectionRecord>;

    updateUser(user: { userId: number; userInfo: UserInfo }): Promise<void>;

    getUser(userId: number): Promise<UserInfo | undefined>;

    updateConnection(connectionId: string, userId: number): Promise<void>;

    findUserByConnectionId(connectionId: string): Promise<number | undefined>;

    updateGameServer(
        commId: number,
        gameServer: IRunningServerInfo,
    ): Promise<void>;

    getGameServers(): Promise<IRunningServerInfo[]>;
}

/**
 * Game data store interface - manages persistent game data
 * This is for PostgreSQL-backed vehicle, parts, and player data
 */
export interface IGameDataStore {
    getPlayer(playerId: number): Promise<Player>;

    getOwnedVehiclesForPerson(personId: number): Promise<OwnedVehicle[]>;

    getVehicleAndParts(vehicleId: number): Promise<VehicleRecord | null>;

    /**
     * Buys a stock car for a live player: in one transaction, takes the price from the player's bank
     * and gives the player the car, built from its stock assembly. The new car's id; undefined when
     * the bank balance does not cover the price.
     */
    purchaseStockCar(
        playerId: number,
        brandedPartId: number,
        skinId: number,
        price: number,
    ): Promise<number | undefined>;
}

/**
 * Auth store interface - manages authentication and local session cache
 * This is for SQLite-backed login credentials and session tracking
 */
export interface IAuthStore {
    readonly isDatabaseConnected: boolean;

    findUser(
        username: string,
        password: string,
    ): Promise<{ customerId: number; userName: string; loginLevel: number; isLocked: boolean }>;

    /** A login by its exact name, for one the site has checked; undefined when there is none. */
    findLogin(
        loginName: string,
    ): Promise<{ customerId: number; userName: string; loginLevel: number; isLocked: boolean } | undefined>;

    findCustomerByContext(contextId: string): UserRecordMini | undefined;

    updateSession(
        customerId: number,
        contextId: string,
        profileId: number,
    ): void;

    /** Makes contextId the customer's only session, ending any earlier one. */
    startSession(customerId: number, contextId: string): void;

    /** Records the address the NPS login for contextId came from. */
    bindSessionAddress(contextId: string, remoteAddress: string): void;

    /** The address the customer's session logged in from, if it has logged in. */
    findSessionAddress(customerId: number): string | undefined;

    registerNewUser(
        username: string,
        password: string,
        customerId: number,
    ): void;

    /** Makes a login with a new customer id; undefined when the name, ignoring case, is taken. */
    createLogin(loginName: string, password: string): Promise<number | undefined>;

    /** Sets a login's password; false when there is no such login. */
    setLoginPassword(loginName: string, password: string): Promise<boolean>;

    /** The login's own spelling when the password is right; undefined for a wrong name or password. */
    verifyLogin(loginName: string, password: string): Promise<string | undefined>;

    /** Locks or unlocks a login; a locked login cannot log in. False when there is no such login. */
    setLoginLocked(loginName: string, isLocked: boolean): Promise<boolean>;

    /** Which of the names are logins, and how many logins there are. */
    findLogins(loginNames: string[]): Promise<string[]>;
    countLogins(): Promise<number>;
}

/**
 * Combined database services interface
 */
/** A persona as the persona list (0x607) carries it. */
export type PersonaSummary = {
    personaId: number;
    customerId: number;
    name: string;
    shardId: number;
    /** Seconds since the Unix epoch. */
    createStamp: number;
};

/**
 * Persona store interface - personas in PostgreSQL. Each is a profile row (the NPS record)
 * and a player row (the game's data) sharing one id; a deleted persona is a Deleted Player.
 */
export interface IPersonaStore {
    listPersonas(customerId: number): Promise<PersonaSummary[]>;

    /** A live persona by its id; undefined when there is none or it was deleted. */
    findPersona(personaId: number): Promise<PersonaSummary | undefined>;

    /** Whether a live persona or a system player already has the name, ignoring case. */
    isPersonaNameTaken(name: string): Promise<boolean>;

    /**
     * Creates a persona: its profile row and player row, under a new id. Undefined when a live
     * persona or system player took the name first.
     */
    createPersona(customerId: number, name: string, shardId: number): Promise<PersonaSummary | undefined>;

    /**
     * Deletes the customer's persona: its player becomes a Deleted Player, keeping its cars, and its
     * name gets a random suffix so the name is free again. False when the customer has no such live persona.
     */
    deletePersona(customerId: number, personaId: number): Promise<boolean>;

    /** A live persona's game data; undefined when there is none or it was deleted. */
    findPlayer(personaId: number): Promise<PersonaPlayer | undefined>;

    /** Sets a live persona's options (MC_SET_OPTIONS); throws when there is no such live persona. */
    setOptions(personaId: number, options: PersonaOptions): Promise<void>;

    /** Sets a live persona's appearance (MC_UPDATE_PLAYER_PHYSICAL); throws when there is no such live persona. */
    setPhysical(personaId: number, physical: PersonaPhysical): Promise<void>;

    /** Sets a live persona's description (MC_SET_PERSONA_DESCRIPTION); throws when there is no such live persona. */
    setDescription(personaId: number, description: string): Promise<void>;

    /** The live personas of the given logins, by login name and persona name, with each one's first car. */
    listPersonasOfLogins(loginNames: string[]): Promise<{ loginName: string; personaName: string; car: PersonaCar | null }[]>;

    /**
     * Moves live personas, by name, from one customer to another in one transaction, cars and all (they belong to the
     * persona). Refused, with nothing moved, when a name is not a live persona of fromCustomerId or toCustomerId would
     * hold more than maximumPersonasPerCustomer. The server keeps no reliable online state, so a persona moves whether or
     * not its owner is logged in. Returns the names as stored.
     */
    movePersonas(personaNames: string[], fromCustomerId: number, toCustomerId: number): Promise<{ moved: string[] } | { refusal: string }>;
}

/**
 * A persona's first car (the starter car: no dealership sells another yet), as its model year, brand and
 * model; null for a persona with no car.
 */
export interface PersonaCar {
    modelYear: number;
    brand: string;
    model: string;
}

/** What MC_SET_OPTIONS sets: the license plate, the car info setting, and the six car numbers. */
export type PersonaOptions = {
    plateCode: number;
    plateText: string;
    carInfoSetting: number;
    /** Six numbers of at most 2 characters each; empty when unset. */
    carNumbers: string[];
};

/** A persona's look; the colors are the client's 32-bit ARGB values, read as signed. */
export type PersonaPhysical = {
    bodyType: number;
    hairColor: number;
    skinColor: number;
    shirtColor: number;
    pantsColor: number;
};

/** A persona's game data, as MC_GET_PLAYER_INFO and MC_GET_PLAYER_PHYSICAL carry it. */
export type PersonaPlayer = PersonaOptions & {
    personaId: number;
    customerId: number;
    name: string;
    bankBalance: number;
    carsOwned: number;
    description: string;
    physical: PersonaPhysical;
};

export interface IDatabaseServices {
    session: ISessionStore;
    gameData: IGameDataStore;
    auth: IAuthStore;
    persona: IPersonaStore;
}

/**
 * Player record from PostgreSQL
 */
export type Player = {
    player_id: number;
    customer_id: number;
    player_type_id: number;
    sanctioned_scole: number;
    challenge_score: number;
    last_logged_in: number;
    times_logged_in: number;
    bank_balance: number;
    num_cars_owned: number;
    driver_style: number;
    lp_code: number;
    lp_text: string;
    car_num1: string;
    car_num2: string;
    car_num3: string;
    car_num4: string;
    car_num5: string;
    dd_number: string;
    persona: string;
    address: string;
    residence: string;
    vehicle_id: number;
    current_race_id: number;
    offline_driver_skill: number;
    offline_grudge: number;
    offline_reputation: number;
    total_time_played: number;
    car_info_setting: number;
    stock_classic_class: number;
    stock_muscle_class: number;
    modified_classic_class: number;
    modified_muscle_class: number;
    outlaw_class: number;
    drag_class: number;
    challenge_rung: number;
    offline_ai_car_class: number;
    offline_ai_car_bpt_id: number;
    offline_state: number;
    body_type: number;
    skin_color: number;
    hair_color: number;
    shirt_xolor: number;
    parts_color: number;
    offline_driver_style: number;
    offline_driver_attitude: number;
    evaded_fuzz: number;
    pinks_won: number;
    num_unread_mail: number;
    total_races_won: number;
    total_races_completed: number;
    total_winnings: number;
    insurance_risk_points: number;
    insurence_rating: number;
    challenge_races_run: number;
    challenge_races_won: number;
    challenge_raced_completed: number;
    cars_lost: number;
    cars_won: number;
};

/**
 * Vehicle part entry
 */
export type PartEntry = {
    partId: number;
    parentPartId: number | null;
    brandedPartId: number;
    percentDamage: number;
    itemWear: number;
    attachmentPointId: number;
    ownerId: number;
    partName: string;
    repairCost: number;
    scrapValue: number;
};

/**
 * Vehicle record with parts
 */
export type VehicleRecord = {
    vehicleId: number;
    skinId: number;
    flags: number;
    class: number;
    infoSetting: number;
    damageInfo: number;
    ownerId: number;
    parts: PartEntry[];
};

/**
 * Owned vehicle summary
 */
export type OwnedVehicle = {
    partId: number;
    parentPartId: number | null;
    brandedPartId: number;
    percentDamage: number;
    itemWear: number;
    attachmentPointId: number;
    ownerId: number;
    partName: string;
    repairCost: number;
    scrapValue: number;
};
