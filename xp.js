const Discord = require("discord.js");
const fs = require("fs");
const config = require("./config.json");
const client = new Discord.Client();
const numeral = require('numeral');

//let points = JSON.parse(fs.readFileSync("points.json", "utf8"));

// Initialize **or load** the points database.
const Enmap = require("enmap");
//const Provider = require("enmap-sqlite");
client.points = new Enmap({
    name: "points"
});
const otherEnmap = new Enmap({
    name: "settings",
    dataDir: './data',
    autoFetch: true,
    fetchAll: false
});

// Using async/await as an immediate function: 
(async function() {
    console.log("[NOTICE] Preparing to load data from cached database. Standby!");
    await client.points.defer;
    console.log("[NOTICE] " + client.points.size + " keys loaded");
    //console.log(Provider);
    // Ready to use!
}());

/*const numberWithCommas = (x) => {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};*/
const borderColor = (x) => {
    if (x == 1 || x == 80000) return "#FF0000";
    if (x == 50 || x == 100 || x == 400) return "#FFFF00";
    if (x == 160000) return "#FF2400";
    if (x == 8000000) return "#00FFFF";
};
const transformLabel = (x) => {
    if (x == 1 || x == 80000) return "";
    if (x == 50) return "SSJ";
    if (x == 100) return "SSJ2";
    if (x == 400) return "SSJ3";
    if (x == 160000) return "SSG";
    if (x == 8000000) return "SSGSS";
}

function getRandomIntInclusive(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min; //The maximum is inclusive and the minimum is inclusive 
}

function containsAny(str, substrings) {
    for (var i = 0; i != substrings.length; i++) {
        var substring = substrings[i];
        if (str.indexOf(substring) != -1) {
            return substring;
        }
    }
    return null;
}

client.on("ready", () => {
    //client.user.setActivity(`on ${client.guilds.size} servers`);
    console.log(`[NOTICE] Bot has started, with ${client.users.size} users, in ${client.channels.size} channels of ${client.guilds.size} guilds.`);
});

client.on("message", async (message) => {
    // If message from self, stop.
    if (!message.guild || message.author.bot) return;
    const rightNow = new Date();
    const key = `${message.guild.id}-${message.author.id}`;

    /*	if (!points[message.guild.id,message.author.id]) {
    		points[message.guild.id,message.author.id] = {
    			points: 2500,
    			level: 1,
    			transformation: 1
    		};
    		let newuser = new Discord.RichEmbed()
    			.setTitle("New User Found!")
    			.setDescription(`Calculating your power ${message.author.username}:`)
    			.setThumbnail(message.author.displayAvatarURL)
    			.setColor("#08ff00")
    			.addField(":crossed_swords:Your Tier", points[message.guild.id,message.author.id].level, true)
    			.addField("Powerlevel", numberWithCommas((points[message.guild.id,message.author.id].points * points[message.guild.id,message.author.id].transformation)), true);
    		message.channel.send(newuser).then(msg => {
    			msg.delete(5000);
    		});
    	}*/
	if (client.points.has(key)) {
		if (client.points.get(key, "godki") > 0) {
			if (((rightNow - client.points.get(key, "lastSeen")) > 30000) && (client.points.get(key, "transformation") == 8000000)) client.points.set(key, 160000, "transformation");
			if (((rightNow - client.points.get(key, "lastSeen")) > 60000) && (client.points.get(key, "transformation") == 160000)) client.points.set(key, 80000, "transformation");
		} else if (client.points.get(key, "godki") < 1) {
			if (((rightNow - client.points.get(key, "lastSeen")) > 120000) && (client.points.get(key, "transformation") == 400)) client.points.set(key, 100, "transformation");
			if (((rightNow - client.points.get(key, "lastSeen")) > 300000) && (client.points.get(key, "transformation") == 100)) client.points.set(key, 50, "transformation");
			if (((rightNow - client.points.get(key, "lastSeen")) > 600000) && (client.points.get(key, "transformation") == 50)) client.points.set(key, 1, "transformation");
		}
	}		
    if (!client.points.has(key)) {
        // We first check if the user's already in enmap. If not, we add him.
        // If the user's already in there for this guild, it means `score` now contains their data. 
        // Otherwise, it's new data with 0 points.
        client.points.set(key, {
            userID: message.author.id,
            guildID: message.guild.id,
            points: 2500,
            level: 1,
            transformation: 1,
			godki: 0,
            lastSeen: rightNow
        });
        let newuser = new Discord.RichEmbed()
            .setTitle("New User Found!")
            .setDescription(`Calculating your power ${message.author.username}:`)
            .setThumbnail(message.author.displayAvatarURL)
            .setColor("#08ff00")
            .addField(":crossed_swords:Your Tier", client.points.get(key, "level"), true)
            .addField("Powerlevel", numeral((client.points.get(key, "points") * client.points.get(key, "transformation"))).format('0.0a'), true);
        message.channel.send(newuser).then(msg => {
            msg.delete(5000);
        });
    }
	
    const ExpMath = ((((Math.sqrt(client.points.get(key, "level")) + 1) * (Math.floor(Math.random() * 187.5) + 437.5)) / (client.points.get(key, "level") + 1)) * (client.points.get(key, "transformation") / client.points.get(key, "level")));

    //let userData = points[message.guild.id,message.author.id];

    let addPoints = ExpMath;

    let transformation = client.points.get(key, "transformation");

    const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
    const command = args.shift().toLowerCase();

    let curPoints = client.points.get(key, "points");
	let godKi = client.points.get(key, "godki");
	let godLevel = 0;
    let curLevel = client.points.get(key, "level");
	if (godKi > 0) godLevel = (curLevel - godKi + 1);
    let curXP = (curPoints - 2500);
    let nxtLvl = Math.ceil(Math.pow((curLevel + 1), 2.5) * (104.167 * Math.sqrt(curLevel * (godLevel + 1))));
    if (!message.content.startsWith(config.prefix)) {
        if (message.content.length < config.minsize) return;
        client.points.set(key, Math.floor(curPoints + addPoints), "points");
    }

    if (nxtLvl <= curXP && !message.content.startsWith(config.prefix)) {
        // Level up!
        client.points.set(key, (curLevel + 1), "level");
        let addPoints = ExpMath;
		if (client.points.get(key, "godki") > 0) {
			let lvlup = new Discord.RichEmbed()
				.setTitle("Level Up!")
				.setDescription(`Congratulations to ${message.author} for reaching God Tier ${(godLevel + 1)}`)
				.setThumbnail(message.author.displayAvatarURL)
				.setColor("#08ff00")
				.addField(":crossed_swords:New God Tier", godLevel + 1, true)
				.addField("Powerlevel", numeral((curPoints * transformation)).format('0.0a'), true)
				.addField("They will gain roughly:", numeral(addPoints).format('0,0') + " power per message.")
				.setFooter(`Scouter Bot ${config.version} | © 2019 ${config.author}`, config.icon);

			message.channel.send(lvlup).then(msg => {
				msg.delete(30000);
			});
		}
		else {
			let lvlup = new Discord.RichEmbed()
				.setTitle("Level Up!")
				.setDescription(`Congratulations to ${message.author} for reaching Tier ${(curLevel + 1)}`)
				.setThumbnail(message.author.displayAvatarURL)
				.setColor("#08ff00")
				.addField(":crossed_swords:New Tier", curLevel + 1, true)
				.addField("Powerlevel", numeral((curPoints * transformation)).format('0.0a'), true)
				.addField("They will gain roughly:", numeral(addPoints).format('0,0') + " power per message.")
				.setFooter(`Scouter Bot ${config.version} | © 2019 ${config.author}`, config.icon);

			message.channel.send(lvlup).then(msg => {
				msg.delete(30000);
			});
		}
    }

    client.points.set(key, rightNow, "lastSeen");

    if (command == 'help') {
		message.delete(1500);
        let help = new Discord.RichEmbed()
            .setTitle("Command List")
            .addField(`${config.prefix}info`, `Displays your current power reading \nand tier level,and how much more \nyou need to advance to the next tier.`, true)
            .addField(`${config.prefix}leaderboard`, `Shows the current leaderboard \nfor ${message.guild}.`, true)
            .addField(`${config.prefix}transform`, `Basic transformation command that \nwill amplify your power based on the \nform you take.  Keep in mind \nthat you must be a certain tier level to use.`)
            .setColor("#008B8B")
            .setFooter(`Scouter Bot ${config.version} | © 2019 ${config.author}`, config.icon);
        message.channel.send(help).then(msg => {
            msg.delete(30000);
        });
    }
    if (command == 'info') {
        message.delete(1500);
		console.log(`Username: ${message.author.username}\nLast Seen: ${client.points.get(key, "lastSeen")}`);
        let difference = nxtLvl - curXP;
		if (client.points.get(key, "godki") > 0) {
			let lvlEmbed = new Discord.RichEmbed()
				.setTitle(`Displaying Current Tier & Power`)
				.setAuthor(`${transformLabel(transformation)} ${message.author.username}`, config.icon)
				.setThumbnail(message.author.displayAvatarURL)
				.setColor(`${borderColor(transformation)}`)
				.addField(":crossed_swords:God Tier", godLevel, true)
				.addField("Powerlevel", `${numeral((curPoints * transformation)).format('0.0a')}`, true)
				.addField("Power per message:", numeral(addPoints).format('0,0') + " power per message.");
			if (difference <= 0) {
				lvlEmbed.setFooter(`You're about to ascend to the next level! Congratulations!`, 'http://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png');
			} else {
				lvlEmbed.setFooter(`${numeral(difference).format('0,0')} additional power needed to reach the next tier!`, 'http://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png');
			}

			message.channel.send(lvlEmbed).then(msg => {
				msg.delete(12500);
			});
		}
		else {
			let lvlEmbed = new Discord.RichEmbed()
				.setTitle(`Displaying Current Tier & Power`)
				.setAuthor(`${transformLabel(transformation)} ${message.author.username}`, config.icon)
				.setThumbnail(message.author.displayAvatarURL)
				.setColor(`${borderColor(transformation)}`)
				.addField(":crossed_swords:Tier", curLevel, true)
				.addField("Powerlevel", `${numeral((curPoints * transformation)).format('0.0a')}`, true)
				.addField("Power per message:", numeral(addPoints).format('0,0') + " power per message.");
			if (difference <= 0) {
				lvlEmbed.setFooter(`You're about to ascend to the next level! Congratulations!`, 'http://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png');
			} else {
				lvlEmbed.setFooter(`${numeral(difference).format('0,0')} additional power needed to reach the next tier!`, 'http://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png');
			}

			message.channel.send(lvlEmbed).then(msg => {
				msg.delete(12500);
			});
		}
    }
    if (command == "leaderboard") {
        var i = 0;
		var ig = 0;
        message.delete(1500);
        // Get a filtered list (for this guild only), and convert to an array while we're at it.
        const filtered = client.points.filterArray(p => p.guildID === message.guild.id);

        // Sort it to get the top results... well... at the top. Y'know.
        const sorted = filtered.sort((a, b) => a.points < b.points);

        // Slice it, dice it, get the top 10 of it!
        const top10 = sorted.splice(0, 10);

        // Now shake it and show it! (as a nice embed, too!)
        const embed = new Discord.RichEmbed()
            .setTitle(`${message.guild} Leaderboard`)
            .setAuthor(client.user.username, client.user.avatarURL)
            .setThumbnail(client.users.get(top10[0].userID).avatarURL)
            .setDescription("Our top 10 strongest members!")
            .setFooter(`Scouter Bot ${config.version} | © 2019 ${config.author}`, config.icon)
            .setColor(0x00AE86);
        for (const data of top10) {
			if (data.godki > 0) {
				ig++;
				embed.addField(`${ig}. ${client.users.get(data.userID).tag}`, `**God Tier Level**: ${(data.level - data.godki + 1)}\n**Powerlevel**: ${numeral((data.points * 80000)).format('0.0a')}`, true);
			}
			else {
				i++;
				embed.addField(`${i}. ${client.users.get(data.userID).tag}`, `**Tier Level**: ${data.level}\n**Powerlevel**: ${numeral(data.points).format('0.0a')}`, true);
			}
        }
        message.channel.send({
            embed
        }).then(msg => {
            msg.delete(30000);
        });
    }
    if (command == 'transform') {
        let [form, grade] = args;
        let validforms = ['normal', 'ssj3', 'ssj2', 'ssj', 'ssgss', 'ssg'];
        message.delete(2000);
        if (args.length < 1 || args[0].toLowerCase() != containsAny(args[0].toLowerCase(), validforms)) {
            let syntax = new Discord.RichEmbed()
                .setAuthor(`${transformLabel(client.points.get(key, "transformation"))} ${message.author.username}`, config.icon)
                .setColor("#FF0000")
                .addField("Error!", "Additional arguments required!")
                .addField("Valid arguments are:", "Normal, SSJ, SSJ2, SSJ3, SSG, SSGSS")
                .setFooter(`Scouter Bot ${config.version} | © 2019 ${config.author}`, config.icon);;
            message.channel.send(syntax).then(msg => {
                msg.delete(10000);
            });
            return;
        } else if (form.toLowerCase() == validforms[0]) {
			if (client.points.get(key, "godki") > 0) client.points.set(key, 80000, "transformation");
			else client.points.set(key, 1, "transformation");
		}
        else if ((form.toLowerCase() == validforms[3]) && (curLevel >= 4 && godKi < 1)) client.points.set(key, 50, "transformation");
        else if ((form.toLowerCase() == validforms[2]) && (curLevel >= 8 && godKi < 1)) client.points.set(key, 100, "transformation");
        else if ((form.toLowerCase() == validforms[1]) && (curLevel >= 16 && godKi < 1)) client.points.set(key, 400, "transformation");
        else if ((form.toLowerCase() == validforms[5]) && (curLevel >= 50)) { 
			if (client.points.get(key, "godki") < 1) client.points.set(key, `${client.points.get(key, "level")}`, "godki");
			client.points.set(key, 160000, "transformation");
		}
        else if ((form.toLowerCase() == validforms[4]) && (curLevel >= 64)) client.points.set(key, 8000000, "transformation");
			
        else {
		if (godKi > 0 && form.toLowerCase() != validforms[4]) {
            let syntax = new Discord.RichEmbed()
                .setAuthor(`${transformLabel(client.points.get(key, "transformation"))} ${message.author.username}`, config.icon)
                .setThumbnail(message.author.displayAvatarURL)
                .setColor("#FF0000")
                .addField("You've ascended to god tier.", "These transformations are no longer relevant to you anymore.");
            message.channel.send(syntax).then(msg => {
                msg.delete(10000);
            });
            return;
        }
            let syntax = new Discord.RichEmbed()
                .setAuthor(`${transformLabel(client.points.get(key, "transformation"))} ${message.author.username}`, config.icon)
                .setThumbnail(message.author.displayAvatarURL)
                .setColor("#FF0000")
                .addField("Level to low!", "Additional power required to transform.");
            message.channel.send(syntax).then(msg => {
                msg.delete(10000);
            });
            return;
        }
        let transformation = client.points.get(key, "transformation");
        let difference = nxtLvl - curXP;
		if (godKi > 0) {
			let lvlEmbed = new Discord.RichEmbed()
				.setTitle((args[0] != "normal") ? `${message.author.username} transformed!` : `${message.author.username} reverted to normal!`)
				.setDescription(`Transformations amplify your power depending on the form you choose!`)
				.setAuthor(`${transformLabel(client.points.get(key, "transformation"))} ${message.author.username}`, config.icon)
				.setThumbnail(message.author.displayAvatarURL)
				.setColor(`${borderColor(transformation)}`)
				.addField(":crossed_swords:God Tier", godLevel, true)
				.addField("Powerlevel", numeral((curPoints * transformation)).format('0.0a'), true)
				.setFooter(`${numeral(difference).format('0,0')} additional power till level up`, 'http://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png');

			message.channel.send(lvlEmbed).then(msg => {
				msg.delete(10000)
			});
		}
		else {
			let lvlEmbed = new Discord.RichEmbed()
				.setTitle((args[0] != "normal") ? `${message.author.username} transformed!` : `${message.author.username} reverted to normal!`)
				.setDescription(`Transformations amplify your power depending on the form you choose!`)
				.setAuthor(`${transformLabel(client.points.get(key, "transformation"))} ${message.author.username}`, config.icon)
				.setThumbnail(message.author.displayAvatarURL)
				.setColor(`${borderColor(transformation)}`)
				.addField(":crossed_swords:Tier", curLevel, true)
				.addField("Powerlevel", numeral((curPoints * transformation)).format('0.0a'), true)
				.setFooter(`${numeral(difference).format('0,0')} additional power till level up`, 'http://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png');

			message.channel.send(lvlEmbed).then(msg => {
				msg.delete(10000)
			});
		}			
    }
	if (command == 'setlevel') {
		// Limited to guild owner - adjust to your own preference!
		if(!message.author.id === message.guild.owner) return message.reply("You're not the boss of me, you can't do that!");

		const user = message.mentions.users.first() || client.users.get(args[0]);
		if(!user) return message.reply("You must mention someone or give their ID!");
		
		const setLevel = parseInt(args[1], 10);
		if(!setLevel) return message.reply("You didn't tell me how many points to give...");
    
		const key = `${message.guild.id}-${user.id}`;

		// Ensure there is a points entry for this user.
		client.points.ensure(key, {
			userID: message.author.id,
            guildID: message.guild.id,
            points: 2500,
            level: 1,
            transformation: 1,
			godki: 0,
            lastSeen: rightNow
		});
		
		client.points.set(key, setLevel, "level");
		
		message.channel.send(`${user.tag} has been set to ${setLevel}.`);
	}
    /*fs.writeFile("./points.json", JSON.stringify(points), (err) => {
    	if (err) console.error(err)
    });*/
});
client.on("error", (e) => console.error(e));
client.on("warn", (e) => console.warn(e));
//client.on("debug", (e) => console.info(e));

client.login(config.token);
