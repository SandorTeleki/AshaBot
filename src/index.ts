
process.env.LOG4JS_CONFIG = process.env.LOG4JS_CONFIG || "res/log4js.json";

require('dotenv').config();
require('source-map-support').install();

import AsciiTable from 'ascii-table';
import AsciiChart from 'asciichart';
import dateFormat from 'dateformat';
import { CategoryChannel, ChannelType, Client, GatewayIntentBits, Guild, GuildChannel, GuildMember, Message, MessageManager, PermissionsBitField, TextChannel, BaseGuildTextChannel } from 'discord.js';
import { keys } from 'lodash';
import { getLogger, shutdown } from 'log4js';
import fs from 'fs/promises';

const log = getLogger();

function cleanup() {
    log.info('Goodbye');
    shutdown();
}

// do app specific cleaning before exiting
process.on('exit', function () {
    cleanup();
});

// catch ctrl+c event and exit normally
process.on('SIGINT', function () {
    log.info('Ctrl-C...');
    cleanup();
    process.exit(2);
});

//catch uncaught exceptions, trace, then exit normally
process.on('uncaughtException', function (e) {
    log.error(`Uncaught Exception... ${e} ${e.name}`);
    log.error(e.stack);
    cleanup();
    process.exit(99);
});

process.on('unhandledRejection', (reason: any, p) => {
    log.error(`Unhandled Rejection at: Promise ${p} reason: ${reason} stack: ${reason?.stack}`);
});


log.info(``);
log.info(`-------------- Application Starting ${new Date()} --------------`);
log.info(``);

const STUDENT_ROLE = process.env.STUDENT_ROLE || "Student" as string;
const MENTOR_ROLE = process.env.MENTOR_ROLE || "Mentor" as string;
const SUB_ROLE = process.env.SUB_ROLE || "BELOVED SUBS" as string;
const BLITZ_ROLE = process.env.BLITZ_ROLE || "Blitzer" as string;
const MENTOR_CATEGORY = process.env.MENTOR_CATEGORY || "Teaching Channel" as string;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!" as string;
const CHANNELS_PER_STUDENT = Number(process.env.CHANNELS_PER_STUDENT || 5);

let MENTOR_CHANNEL_GREETING = "";
fs.readFile("res/mentor_greeting.txt", {encoding: 'utf-8'}).then(txt => MENTOR_CHANNEL_GREETING = txt).catch(er => {throw new Error(er);});
require('./ValidateEnv.js').validate();

const BANNED_PREFIXES: string[] = require('../res/banned_prefixes.json').values;
if(BANNED_PREFIXES.indexOf(COMMAND_PREFIX) != -1){
    throw new Error(`Requested command prefix is disallowed! ${COMMAND_PREFIX}`);
}
const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});
const TOKEN = process.env.TOKEN;

export function getDiscordBot() {
    return bot;
}

const SEC_IN_MIN = 60;
const SEC_IN_HOUR = SEC_IN_MIN * 60;
const SEC_IN_DAY = SEC_IN_HOUR * 24;

function getSeconds(str: string) {
    if (str.startsWith('-')) throw `Negative times aren't allowed! ${str}`;
    let seconds = 0;
    const days = str.match(/(\d+)\s*d/);
    const hours = str.match(/(\d+)\s*h/);
    const minutes = str.match(/(\d+)\s*m/);
    const rawSeconds = str.match(/(\d+)\s*s/);
    if (days) { seconds += parseInt(days[1]) * SEC_IN_DAY; }
    if (hours) { seconds += parseInt(hours[1]) * SEC_IN_HOUR; }
    if (minutes) { seconds += parseInt(minutes[1]) * SEC_IN_MIN; }
    if (rawSeconds) { seconds += parseInt(rawSeconds[1]); }
    return seconds;
}

function logBase(x, y){
    return Math.log(y) / Math.log(x);
}

async function findCategories(guild: Guild) {
    const roles = await guild.roles.fetch();
    const categoryRole = roles.find(role => role.name == MENTOR_CATEGORY);
    const categories: { [index: string]: CategoryChannel[] } = {};
    guild.channels.cache.forEach(channel => {
        if (channel.type == ChannelType.GuildCategory && categoryRole?.id && channel.permissionOverwrites.cache.find(overwrite => overwrite.id == categoryRole?.id)) {
            const category = channel.name.split(' ')[0].toLowerCase();
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(channel as CategoryChannel);
        }
    });
    return categories;
}

async function extendCategory(categoryName: string, msg: Message & { guild: Guild }) {
    log.info(`Extending ${categoryName}`);
    const channelRole = await findRole(msg, MENTOR_CATEGORY);
    if (!channelRole) {
        return null;
    }
    let counter = 1;
    let position = -1;
    let lastFoundCategory = msg.guild.channels.cache.find(channel => channel.name.toLowerCase() == `${categoryName} ${counter}`);
    if (lastFoundCategory) {
        position = (lastFoundCategory as CategoryChannel).position;
        while ((lastFoundCategory = msg.guild.channels.cache.find(channel => channel.name.toLowerCase() == `${categoryName} ${counter}`)) != null) {
            position = (lastFoundCategory as CategoryChannel).position;
            counter++;
            if (counter > 10) {
                return null;
            }
        }
        return await msg.guild.channels.create({
            name: `${categoryName} ${counter}`,
            type: ChannelType.GuildCategory,
            position: position,
            permissionOverwrites: [{
                id: channelRole.id
            }
            ]
        });
    }
    return null;
}

async function findRole(msg: Message & { guild: Guild }, roleName: string) {
    const role = (await msg.guild.roles.fetch()).find(role => role.name == roleName);
    if (!role) {
        await sendMessage(msg, `Server has no ${roleName} role!`);
        return;
    }
    return role;
}

function hasGuild(obj: any): obj is { guild: Guild } {
    return 'guild' in obj;
}

function hasMessages(obj: any): obj is { messages: MessageManager } {
    return 'messages' in obj;
}

function isTextBasedChannel(channel: any): channel is TextChannel {
    return channel && 'send' in channel;
}

async function sendMessage(msg: Message & { guild: Guild }, text: string) {
    await (msg.channel as BaseGuildTextChannel).send(text);
}

async function mentor(msg: Message & { guild: Guild }) {
    const existingChannels = findUser(msg, true);
    if ((await existingChannels).length > CHANNELS_PER_STUDENT) {
        await sendMessage(msg, `You are at capacity!`);
        await findUser(msg);
        return;
    }
    const mentorRole = await findRole(msg, MENTOR_ROLE);
    if (!mentorRole) {
        return;
    }
    const studentRole = await findRole(msg, STUDENT_ROLE);
    if (!studentRole) {
        return;
    }

    const parts = msg.content.split(' ');
    if (parts.length < 3) {
        await sendMessage(msg, `Please format the request in \`${COMMAND_PREFIX}mentor <CATEGORY> <NATION>\``);
        return;
    }
    const categoryName = parts[1].toLowerCase();
    const categories = await findCategories(msg.guild);
    if (!categories[categoryName]) {
        await sendMessage(msg, `Unrecognized Category! Recognized Categories: "${keys(categories).join('", "')}"`);
        return;
    }

    let category: CategoryChannel | null = null;
    for (const channel of categories[categoryName]) {
        if (channel.children.cache.size < 50) {
            category = channel;
            break;
        }
    }
    if (category == null) {
        category = await extendCategory(categoryName, msg);
        if (category == null) {
            await sendMessage(msg, `Out of room for ${categoryName}! Ask someone to make more!`);
            return;
        }
    }

    const nation = parts.splice(2).join('');
    const mentorChannel = await msg.guild.channels.create({
        name: `${msg.member?.displayName}-${nation}`,
        type: ChannelType.GuildText,
        parent: category?.id,
        permissionOverwrites: [
            {
                id: msg.guild.id,
                deny: ['ViewChannel'],
            },
            {
                id: msg.author.id,
                allow: ['ViewChannel', 'ManageMessages', 'SendMessages'],
            },
            {
                id: mentorRole.id,
                allow: ['ViewChannel', 'ManageMessages', 'SendMessages'],
            },
        ]
    });
    await msg.member?.roles.add(studentRole);
    await sendMessage(msg, `Created ${mentorChannel.toString()}`);
    await mentorChannel.send(MENTOR_CHANNEL_GREETING.replace('@name', msg.member?.toString() || `${STUDENT_ROLE}`));
}

async function initGuild(msg: Message & { guild: Guild }) {
    const permResult = 268504272n & (msg.guild.members.me?.permissions.bitfield || 0n);
    if (permResult != 268504272n) {
        const p = new PermissionsBitField(268504272n);
        const flags: string[] = [];
        for (const [key, value] of Object.entries(PermissionsBitField.Flags)) {
            if (p.has(value) && !msg.guild.members.me?.permissions.has(value)) {
                flags.push(key);
            }
        }
        await sendMessage(msg, `Missing permissions!\n${flags.join('\n')}`);
        return;
    }
    log.info(`initalizing ${msg.guild.name}`);
    const roles = await msg.guild.roles.fetch();
    let changed = false;
    if (!roles.find(role => role.name == STUDENT_ROLE)) {
        const role = await msg.guild.roles.create({ name: STUDENT_ROLE, mentionable: false, permissions: [] });
        await sendMessage(msg, `Created ${role.toString()} as student role`);
        changed = true;
    }
    if (!roles.find(role => role.name == MENTOR_ROLE)) {
        const mentorRole = await msg.guild.roles.create({ name: MENTOR_ROLE, mentionable: false, permissions: [] });
        await sendMessage(msg, `Created ${mentorRole.toString()} as mentor role`);
        changed = true;
        await msg.guild.members.me?.roles.add(mentorRole);
    }
    if (!roles.find(role => role.name == SUB_ROLE)) {
        const subRole = await msg.guild.roles.create({ name: SUB_ROLE, mentionable: false, permissions: [] });
        await sendMessage(msg, `Created ${subRole.toString()} as sub role`);
        changed = true;
    }
    if (!roles.find(role => role.name == BLITZ_ROLE)) {
        const blitzRole = await msg.guild.roles.create({ name: BLITZ_ROLE, mentionable: false, permissions: [] });
        await sendMessage(msg, `Created ${blitzRole.toString()} as blitz role`);
        changed = true;
    }
    let categoryRole = roles.find(role => role.name == MENTOR_CATEGORY);
    if (!categoryRole) {
        categoryRole = await msg.guild.roles.create({ name: MENTOR_CATEGORY, mentionable: false, permissions: [] });
        await sendMessage(msg, `Created ${categoryRole.toString()} as mentor channel role`);
        changed = true;
    }
    if (changed) {
        log.info(`initalized ${msg.guild.name}`);
        await sendMessage(msg, `Initalized ${msg.guild.name}`);
    } else {
        if (msg.member?.roles.cache.find(role => role.name == MENTOR_ROLE) != null) {
            await sendMessage(msg, `Already initalized`);
        }
    }
}

async function findStales(msg: Message & { guild: Guild }) {
    const role = await findRole(msg, MENTOR_ROLE);
    if (!role) {
        return;
    }

    if (msg.member?.roles.cache.find(r => r.id == role?.id) == null) {
        return;
    }

    let lastTalkThreashold: Date | null = null;

    if (msg.content.split(' ').length > 1) {
        const rawTime = msg.content.split(' ').slice(1).join(' ');
        const ms = getSeconds(rawTime) * 1000;
        lastTalkThreashold = new Date();
        lastTalkThreashold.setTime(lastTalkThreashold.getTime() - ms);
    }

    log.info(`${lastTalkThreashold}`);

    const onlyMentors: string[] = [];
    const idle: string[] = [];

    const categories = await findCategories(msg.guild);
    for (const parentCategory in categories) {
        const subcategorys = categories[parentCategory];
        for (const subcategory of subcategorys) {
            const channels: GuildChannel[] & { messages: MessageManager }[] = [];
            subcategory.children.cache.forEach(channel => {
                let foundOnlyMentors = true;
                channel.members.forEach(member => {
                    if (member.user.id == bot.user?.id) return;
                    if (member.roles.cache.find(r => r.id == role?.id) == null) {
                        foundOnlyMentors = false;
                    }
                });
                if (foundOnlyMentors) {
                    onlyMentors.push(channel.toString());
                } else if (lastTalkThreashold && hasMessages(channel)) {
                    channels.push(channel);
                }
            });
            if (lastTalkThreashold) {
                for (const channel of channels) {
                    try {
                        const messages = await channel.messages.fetch({ limit: 1 });
                        const m = messages.first();
                        if (!m || m.createdTimestamp < lastTalkThreashold.getTime()) {
                            idle.push(channel.toString());
                        }
                    } catch (err) {
                        log.error(err);
                    }
                }
            }
        }
    }
    if (onlyMentors.length > 0) {
        await sendMessage(msg, `Only ${role.name}:\n${onlyMentors.slice(0, Math.min(50, onlyMentors.length)).join('\n')}`);
    }
    if (idle.length > 0) {
        await sendMessage(msg, `Idle since ${dateFormat(lastTalkThreashold, 'yyyy-mm-dd HH:MM')}:\n${idle.slice(0, Math.min(50, idle.length)).join('\n')}`);
    }
    if (onlyMentors.length == 0 && idle.length == 0) {
        await sendMessage(msg, `No stale channels found`);
    }
}

async function findUser(msg: Message & { guild: Guild }, quiet?: boolean) {
    let userID = msg.author.id;
    const mentionedUser = msg.mentions.users.first();
    if (mentionedUser && msg.member?.roles.cache.find(role => role.name == MENTOR_ROLE)) {
        userID = mentionedUser.id;
    }

    const categories = await findCategories(msg.guild);
    const found: string[] = [];
    for (const parentCategory in categories) {
        const subcategorys = categories[parentCategory];
        for (const subcategory of subcategorys) {
            const channels: GuildChannel[] & { messages: MessageManager }[] = [];
            subcategory.children.cache.filter(channel => channel.permissionOverwrites.cache.find(overwrite => overwrite.id == userID) != null).forEach(c => channels.push(c));
            for (const c of channels) {
                if (found.length < 50) {
                    found.push(c.toString());
                }
            }
        }
    }
    if(!quiet){
        await sendMessage(msg, `Found: ${found.join(' ')}`);
    }
    return found;
}

async function rename(msg: Message & { guild: Guild }) {
    const parts = msg.content.split(' ');
    if (parts.length < 3) {
        await sendMessage(msg, `Please format the request in \`!mentor <NEW_ERA> <NEW_NATION>\``);
        return;
    }

    const mentorRole = await findRole(msg, MENTOR_ROLE);
    if (!mentorRole) {
        return;
    }

    const channel = msg.channel as GuildChannel;
    const categories = await findCategories(msg.guild);
    let isInCategory = false;
    for (const group in categories) {
        for (const category of categories[group]) {
            if (channel.parentId == category.id) {
                isInCategory = true;
            }
        }
    }
    if (!isInCategory) {
        log.debug(`Requested to rename channel not in category: ${channel.name}`);
        return;
    }
    const targetChannel = msg.channel as GuildChannel;
    if (channel.permissionOverwrites.cache.find(overwrite => overwrite.id == msg.author.id) == null) {
        log.debug(`Non owner requested rename of un authorized channel. ${msg.member?.displayName}, ${targetChannel.name}`);
        await sendMessage(msg, `Only channel owners may use this command`);
        return;
    }

    const categoryName = parts[1].toLowerCase();
    if (!categories[categoryName]) {
        await sendMessage(msg, `Unrecognized era! Recognized Eras: ${keys(categories).join(' ')}`);
        return;
    }
    let category: CategoryChannel | null = null;
    for (const channel of categories[categoryName]) {
        if (channel.children.cache.size < 50) {
            category = channel;
            break;
        }
    }
    if (category == null) {
        category = await extendCategory(categoryName, msg);
    }
    if (category == null) {
        await sendMessage(msg, `Out of room for ${categoryName}! Ask some one to make more!`);
        return;
    }
    const nation = parts.splice(2).join('');

    await targetChannel.edit({
        parent: category.id,
        name: `${msg.member?.displayName}-${nation}`
    });

    await sendMessage(msg, `Renamed to ${targetChannel.toString()}`);
}

async function DRN(msg: Message & { guild: Guild }) {
    const role = await findRole(msg, MENTOR_ROLE);
    if (!role) {
        return;
    }

    const DRN_REGEX = /(?<ATK>\d+)\s*vs?\s*(?<DEF>\d+)/;
    const match = DRN_REGEX.exec(msg.content);

    function drn(depth: number) {
        if (depth > 20) return 10000;
        const roll = Math.ceil(Math.random() * 6);
        if (roll == 6) {
            return 5 + drn(depth++);
        }
        return roll;
    }

    if (match && match?.groups) {
        const atk = Number(match.groups['ATK']);
        const def = Number(match.groups['DEF']);
        const result = { wins: 0, losses: 0, values: [] as number[] };
        let count = 0;
        let sum = 0;
        while (count++ < 1000) {
            const atkDrn = drn(0) + drn(0) + atk;
            const defDrn = drn(0) + drn(0) + def;
            const roll = atkDrn - defDrn;
            sum += roll;
            result.values.push(roll);
            if (roll > 0) {
                result.wins++;
            } else {
                result.losses++;
            }
        }
        result.values = result.values.sort((a, b) => a - b);
        const rolls = result.wins + result.losses;

        const zero: number[] = [];
        const breakdown: number[] = [];
        const granularity = 30;
        for (let i = 0; i < granularity; i++) {
            zero[i] = 0;
            let index = Math.floor((i / granularity) * result.values.length);
            //exclude the lowest and highest rolls
            index = Math.max(10, Math.min(result.values.length - 10, index));
            breakdown[i] = result.values[index];
        }

        const table = new AsciiTable(`${atk} vs ${def}`);
        table.addRow('Avg', (sum / count).toFixed(2));
        table.addRow('Win %', ((result.wins / rolls) * 100).toFixed(2));
        table.addRow('50% win',Math.ceil(logBase(.5, (result.wins / rolls))));
        table.addRow('75% win',Math.ceil(logBase(.75, (result.wins / rolls))));
        table.addRow('90% win',Math.ceil(logBase(.9, (result.wins / rolls))));
        table.addRow('95% win',Math.ceil(logBase(.95, (result.wins / rolls))));

        const tableStr = table.toString().split('\n') as string[];
        const graph = AsciiChart.plot([zero, breakdown], { height: tableStr.length }).split('\n') as string[];
        const output: string[] = [];
        output.push('```');
        for (let i = 0; i < tableStr.length; i++) {
            output.push(`${tableStr[i]} ${graph[i]}`.trimEnd());
        }
        output.push('```');
        await sendMessage(msg, `${output.join('\n')}`);
    } else {
        await sendMessage(msg, `Unrecognized input`);
    }
}

async function bulkApplyStudentTag(msg: Message & { guild: Guild }) {
    const mentorRole = await findRole(msg, MENTOR_ROLE);
    const studentRole = await findRole(msg, STUDENT_ROLE);
    if (!mentorRole || !studentRole) {
        return;
    }
    let changes = 0;
    const categories = await findCategories(msg.guild);
    const userMap = {};
    log.debug(`Found categories ${JSON.stringify(categories)}`);
    for (const parentCategory in categories) {
        log.debug(`Checking parent category ${parentCategory}`);
        const subcategorys = categories[parentCategory];
        for (const subcategory of subcategorys) {
            log.debug(`Checking sub category ${subcategory.name}`);
            const students: GuildMember[] = [];
            subcategory.children.cache.forEach(channel => {
                log.debug(`Checking channel ${channel.name}`);
                channel.members.forEach(member => {
                    if (member.user.id == bot.user?.id) return;
                    if (member.roles.cache.find(r => r.id == mentorRole?.id) == null) {
                        students.push(member);
                    }
                });
            });
            for (const student of students) {
                if (!userMap[student.id]) {
                    await student.roles.add(studentRole);
                    changes++;
                    userMap[student.id] = true;
                }
            }
        }
    }
    await sendMessage(msg, `Added ${studentRole.toString()} to ${changes} users`);
}

async function findStudents(msg:Message & {guild: Guild}) {
    const role = await findRole(msg, MENTOR_ROLE);
    if (!role) {
        return;
    }

    if (msg.member?.roles.cache.find(r => r.id == role?.id) == null) {
        return;
    }
    const categories = await findCategories(msg.guild);
    const channels: { [k : string]:string } = {};
    for (const parentCategory in categories) {
        const subcategorys = categories[parentCategory];
        for (const subcategory of subcategorys) {
            for(const c of subcategory.children.cache.values()){
                if(msg.guild.members.me && !c.permissionsFor(msg.guild.members.me)?.has('ViewChannel')) continue;
                const channel = (c as TextChannel);
                try{
                    const msgs = await channel.messages.fetch({ limit: 5 });
                    let found = false;
                    for(const m of msgs.values()){
                        if(m.member?.roles.cache.find(r => r.id == role?.id) != null){
                            found = true;
                            break;
                        }
                    }
                    if(!found){
                        channels[c.id] = c.toString();
                    }
                }catch(er){
                    log.error(`Error fetching channel messages ${channel.name} ${er}`);
                }
                if(Object.values(channels).length >= 50) break;
            }
            if(Object.values(channels).length >= 50) break;
        }
        if(Object.values(channels).length >= 50) break;
    }
    await sendMessage(msg, `Found ${Object.values(channels).length} channels\n${Object.values(channels).join('\n')}`);
}

async function addSubRole(msg: Message & {guild: Guild}){
    const role = await findRole(msg, SUB_ROLE);
    if (!role) {
        await sendMessage(msg, `Failed to find role ${SUB_ROLE}`);
        return;
    }

    if(!msg.member){
        await sendMessage(msg, `This only works in guild channels!`);
        return;
    }

    if(msg.member.roles.cache.find(r => r.id == role.id) != null){
        await sendMessage(msg, `Looks like I already love you as much as I can! I can only love you more if you don't have the ${SUB_ROLE} role!`);
    }

    await msg.member.roles.add(role);
    await sendMessage(msg, `Now I love you the maxium amount! Thank you for being a ${SUB_ROLE}`);
    return;
}

async function removeSubRole(msg: Message & {guild: Guild}){
    const role = await findRole(msg, SUB_ROLE);
    if (!role) {
        await sendMessage(msg, `Failed to find role ${SUB_ROLE}`);
        return;
    }

    if(!msg.member){
        await sendMessage(msg, `This only works in guild channels!`);
        return;
    }

    if(msg.member.roles.cache.find(r => r.id == role.id) == null){
        await sendMessage(msg, `Looks like you've already left me! You can only leave me to my sorrows if you have the ${SUB_ROLE} role!`);
    }

    await msg.member.roles.remove(role);
    await sendMessage(msg, `You have left me! I'll try to remember the time when you were a ${SUB_ROLE}`);
    return;
}

async function addBlitzRole(msg: Message & {guild: Guild}){
    const role = await findRole(msg, BLITZ_ROLE);
    if (!role) {
        await sendMessage(msg, `Failed to find role ${BLITZ_ROLE}`);
        return;
    }

    if(!msg.member){
        await sendMessage(msg, `This only works in guild channels!`);
        return;
    }

    if(msg.member.roles.cache.find(r => r.id == role.id) != null){
        await sendMessage(msg, `Looks like I already blitz you as much as I can! I can only blitz you more if you don't have the ${BLITZ_ROLE} role!`);
    }

    await msg.member.roles.add(role);
    await sendMessage(msg, `Now I blitz you the maxium amount! Thank you for being a ${BLITZ_ROLE}`);
    return;
}

async function removeBlitzRole(msg: Message & {guild: Guild}){
    const role = await findRole(msg, BLITZ_ROLE);
    if (!role) {
        await sendMessage(msg, `Failed to find role ${BLITZ_ROLE}`);
        return;
    }

    if(!msg.member){
        await sendMessage(msg, `This only works in guild channels!`);
        return;
    }

    if(msg.member.roles.cache.find(r => r.id == role.id) == null){
        await sendMessage(msg, `Looks like you don't want to be blitzed! You can only renounce being blitzed if you have the ${BLITZ_ROLE} role!`);
    }

    await msg.member.roles.remove(role);
    await sendMessage(msg, `You have activated a NAP3! I can no longer blitz you... I'll try to remember the time when you were a ${BLITZ_ROLE}`);
    return;
}

bot.on('ready', () => {
    log.info(`Logged in as ${bot?.user?.tag}!`);
});

bot.on('messageCreate', async msg => {
    //log.debug(`processing from ${msg.member?.displayName}`);
    try {
        if (!msg.content.startsWith(`${COMMAND_PREFIX}`) || msg.channel.type == ChannelType.DM || BANNED_PREFIXES.filter(ban => msg.content.startsWith(ban)).length > 0) {
            return;
        }
        const command = msg.content.substring(COMMAND_PREFIX.length);
        if (hasGuild(msg)) {
            const mentorCMD = `${MENTOR_ROLE}`.toLowerCase();
            log.info(`processing ${command} from ${msg.member?.displayName} in ${msg.channel.name}`);
            const thinkies = await msg.react('🤔');
            try {
                switch (command.split(' ')[0].toLowerCase()) {
                    case 'init':
                        await initGuild(msg);
                        break;
                    case mentorCMD:
                        await mentor(msg);
                        break;
                    case 'rename':
                        await rename(msg);
                        break;
                    case 'find':
                        await findUser(msg);
                        break;
                    case 'stales':
                        await findStales(msg);
                        break;
                    case 'drn':
                        await DRN(msg);
                        break;
                    case 'findstudents':
                        await findStudents(msg);
                        break;
                    case 'bulkapplystudenttag':
                        await bulkApplyStudentTag(msg);
                        break;
                    case 'loveme':
                        await addSubRole(msg);
                        break;
                    case 'leaveme':
                        await removeSubRole(msg);
                        break;
                    case 'blitzme':
                        await addBlitzRole(msg);
                        break;
                    case 'protectme':
                        await removeBlitzRole(msg);
                        break;
                    case 'help': {
                        const cmds: string[] = [];
                        cmds.push('Commands');
                        cmds.push('```');
                        cmds.push(`${COMMAND_PREFIX}${mentorCMD} <category> <nation> -- create a ${mentorCMD} channel for yourself`);
                        cmds.push(`${COMMAND_PREFIX}rename <category> <nation> -- rename your ${mentorCMD} channel (must be done within your ${mentorCMD} channel)`);
                        cmds.push(`${COMMAND_PREFIX}drn <number_A> vs <number_B> -- generate stats for an opposed 2drn vs 2drn check - gives the success probability of A beating B by one or more`);
                        cmds.push(`${COMMAND_PREFIX}find -- find your channel`);
                        cmds.push(`${COMMAND_PREFIX}loveMe causes me to love you more (Gives you the ${SUB_ROLE} role)`);
                        cmds.push(`${COMMAND_PREFIX}leaveMe because you don't love me anymore (Removes the ${SUB_ROLE} role)`);
                        cmds.push(`${COMMAND_PREFIX}blitzMe causes me to blitz you more (Gives you the ${BLITZ_ROLE} role)`);
                        cmds.push(`${COMMAND_PREFIX}protectMe because you don't want to be a Blitzer anymore (Removes the ${BLITZ_ROLE} role)`);
                        if (msg.member?.roles.cache.find(r => r.name == MENTOR_ROLE) != null) {
                            cmds.push(`[${MENTOR_ROLE} only] ${COMMAND_PREFIX}findStudents -- find ${mentorCMD} channel(s) where a mentor hasn't talked in the last five messages`);
                            cmds.push(`[${MENTOR_ROLE} only] ${COMMAND_PREFIX}find <@user> -- find ${mentorCMD} channel(s) for a user`);
                            cmds.push(`[${MENTOR_ROLE} only] ${COMMAND_PREFIX}stales <optional time: 1d> -- limit 50 channels`);
                        }
                        cmds.push('```');
                        await sendMessage(msg, `${cmds.join('\n')}`);
                        break;
                    }
                    default:
                        await sendMessage(msg, `Unrecognized command! try ${COMMAND_PREFIX}help for a list of commands`);
                        await msg.react('👎');
                        return;
                }
                await msg.react('💯');
            } catch (e) {
                await msg.react('🤯');
                throw e;
            }finally{
                await thinkies.remove();
            }
            log.debug(`finished processing ${command} from ${msg.member?.displayName}`);
        }
    } catch (err) {
        log.error(`Error handling command: ${err}`);
    }
});

bot.login(TOKEN).catch(err => {
    log.error(`Failed to log in ${err}`);
    throw err;
});
