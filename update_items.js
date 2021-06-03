const OVERWRITES = {
	AMP: {
		"Mote Prism": {
			components: {
				"Cetus Wisp": 1,
				"Tear Azurite": 20,
				"Pyrotic Alloy": 10,
				"Fish Oil": 30
			},
			buildTime: 600,
			buildPrice: 1000
		}
	},
	AW_GUN: {
		"Prisma Dual Decurions": { mr: 10 }
	},
	CAT: { Venari: {} },
	MISC: { Plexus: { xp: 6000 } }
};
const BLACKLIST = ["Prisma Machete"];

const fetch = require("node-fetch");
const fs = require("fs/promises");
const jsonDiff = require("json-diff");
const lzma = require("lzma");
const { Webhook } = require("discord-webhook-node");

const API_URL = "https://content.warframe.com";
const ITEM_ENDPOINTS = ["Warframes", "Weapons", "Sentinels"];
const WIKI_URL = "https://warframe.fandom.com/wiki";

class ItemUpdater {
	constructor(overwrites, blacklist) {
		this.overwrites = overwrites;
		this.blacklist = blacklist;
	}

	async run() {
		this.processedItems = {
			WF: {},
			PRIMARY: {},
			SECONDARY: {},
			KITGUN: {},
			MELEE: {},
			ZAW: {},
			SENTINEL: {},
			SENTINEL_WEAPON: {},
			AMP: {},
			AW: {},
			AW_GUN: {},
			AW_MELEE: {},
			DOG: {},
			CAT: {},
			MOA: {},
			KDRIVE: {},
			MECH: {},
			MISC: {}
		};

		await this.fetchEndpoints();
		await Promise.all([
			this.fetchItems(),
			this.fetchRecipes(),
			this.fetchRelics()
		]);

		this.mapItemNames(
			this.items,
			(await this.fetchEndpoint("Resources")).ExportResources
		);

		this.processItems();
		this.processedItems = this.mergeObjects(
			this.processedItems,
			this.overwrites
		);
		this.orderItems();
	}

	orderItems() {
		this.processedItems = Object.entries(this.processedItems).reduce(
			(sortedCategories, [category, items]) => {
				sortedCategories[category] = Object.keys(items)
					.sort()
					.reduce((sortedItems, name) => {
						sortedItems[name] = items[name];
						return sortedItems;
					}, {});
				return sortedCategories;
			},
			{}
		);
	}

	mergeObjects(target, source) {
		const output = { ...target };
		Object.entries(source).forEach(([key, value]) => {
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				key in target
			)
				output[key] = this.mergeObjects(target[key], source[key]);
			else Object.assign(output, { [key]: value });
		});
		return output;
	}

	processItems() {
		Object.values(this.items).forEach(item => {
			const type = this.categorizeItem(item);
			const name = this.processItemName(item.name);
			if (type && !this.blacklist.includes(name)) {
				const recipe = this.recipes[item.uniqueName];
				const processedItem = {
					maxLvl: type === "MECH" ? 40 : item.maxLevelCap,
					mr: item.masteryReq
				};
				if (recipe) {
					if (
						this.relics[recipe.uniqueName] &&
						Object.values(this.relics[recipe.uniqueName]).every(
							relic => relic.vaulted
						)
					)
						processedItem.vaulted = true;
					if (recipe.ingredients?.length > 0)
						processedItem.components = this.processRecipe(recipe);
					processedItem.buildTime = recipe.buildTime;
					processedItem.buildPrice = recipe.buildPrice;
				}
				if (name.startsWith("Mk1-"))
					processedItem.wiki = `${WIKI_URL}/${name.replace(
						"Mk1-",
						"MK1-"
					)}`;

				Object.entries(processedItem).forEach(([key, value]) => {
					if (!value) delete processedItem[key];
				});
				this.processedItems[type][name] = processedItem;
			}
		});
	}

	processRecipe(recipe, count = 1) {
		return Object.entries(
			recipe.ingredients.reduce((ingredients, ingredient) => {
				const ingredientRawName = ingredient.ItemType;
				const ingredientName = this.itemNames[ingredientRawName];
				if (!ingredients[ingredientName])
					ingredients[ingredientName] = {
						count: 0
					};
				const ingredientData = ingredients[ingredientName];
				ingredientData.count += ingredient.ItemCount * count;

				if (
					ingredientRawName.includes("WeaponParts") ||
					ingredientRawName.includes("WarframeRecipes")
				)
					ingredientData.generic = true;

				if (this.recipes[ingredientRawName]?.ingredients.length > 0) {
					if (
						!ingredientRawName.includes("Items") &&
						(!ingredientRawName.includes("Gameplay") ||
							ingredientRawName.includes("Mechs"))
					) {
						ingredientData.components = this.processRecipe(
							this.recipes[ingredientRawName],
							ingredients[ingredientName].count
						);
					}
				}

				return ingredients;
			}, {})
		).reduce((ingredients, [ingredientName, ingredient]) => {
			ingredients[ingredientName] =
				Object.keys(ingredient).length <= 1
					? ingredient.count
					: ingredient;
			return ingredients;
		}, {});
	}

	categorizeItem(item) {
		const uniqueName = item.uniqueName;
		let type;
		switch (item.productCategory) {
			case "Pistols":
				if (uniqueName.includes("ModularMelee")) {
					if (
						uniqueName.includes("Tip") &&
						!uniqueName.includes("PvPVariant")
					)
						type = "ZAW";
					break;
				}
				if (
					uniqueName.includes("ModularPrimary") ||
					uniqueName.includes("ModularSecondary") ||
					uniqueName.includes("InfKitGun")
				) {
					if (uniqueName.includes("Barrel")) type = "KITGUN";
					break;
				}
				if (uniqueName.includes("OperatorAmplifiers")) {
					if (uniqueName.includes("Barrel")) type = "AMP";
					break;
				}
				if (uniqueName.includes("Hoverboard")) {
					if (uniqueName.includes("Deck")) type = "KDRIVE";
					break;
				}
				if (uniqueName.includes("MoaPets")) {
					if (uniqueName.includes("MoaPetHead")) type = "MOA";
					break;
				}
				if (item.slot === 0) type = "SECONDARY";
				break;
			case "KubrowPets":
				type = uniqueName.includes("Catbrow") ? "CAT" : "DOG";
				break;
			default:
				type = {
					SpaceMelee: "AW_MELEE",
					SpaceGuns: "AW_GUN",
					SpaceSuits: "AW",
					Suits: "WF",
					MechSuits: "MECH",
					LongGuns: "PRIMARY",
					Melee: "MELEE",
					Sentinels: "SENTINEL",
					SentinelWeapons: "SENTINEL_WEAPON"
				}[item.productCategory];
		}
		return type;
	}

	mapItemNames() {
		this.itemNames = {};

		Object.values(Array.from(arguments)).forEach(items => {
			items.forEach(item => {
				if (item.uniqueName && item.name)
					this.itemNames[item.uniqueName] = this.processItemName(
						item.name
					);
			});
		});
	}

	processItemName(name) {
		return name
			.replace("<ARCHWING> ", "")
			.toLowerCase()
			.split(" ")
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ")
			.split("-")
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join("-");
	}

	async fetchRelics() {
		this.relics = {};
		(await this.fetchEndpoint("RelicArcane")).ExportRelicArcane.forEach(
			relic => {
				if (relic.relicRewards)
					relic.relicRewards.forEach(reward => {
						const rewardName = reward.rewardName.replace(
							"/StoreItems",
							""
						);
						if (!this.relics[rewardName])
							this.relics[rewardName] = {};
						this.relics[rewardName][relic.name] = {
							rarity: reward.rarity
						};
						if (relic.codexSecret)
							this.relics[rewardName][relic.name].vaulted = true;
					});
			}
		);
	}

	async fetchRecipes() {
		this.recipes = (
			await this.fetchEndpoint("Recipes")
		).ExportRecipes.reduce((recipes, recipe) => {
			const invalidBPs = [
				"/Lotus/Types/Recipes/Weapons/CorpusHandcannonBlueprint",
				"/Lotus/Types/Recipes/Weapons/GrineerCombatKnifeBlueprint"
			];
			if (
				!invalidBPs.includes(recipe.uniqueName) &&
				!recipes[recipe.resultType]
			)
				recipes[recipe.resultType] = recipe;
			return recipes;
		}, {});
	}

	async fetchItems() {
		const data = await Promise.all(
			ITEM_ENDPOINTS.map(async e => {
				return (await this.fetchEndpoint(e))[`Export${e}`];
			})
		);
		this.items = data.reduce((merged, d) => {
			return [...merged, ...d];
		}, []);
	}

	async fetchEndpoint(endpoint) {
		return this.parseDamagedJSON(
			await (
				await fetch(
					`${API_URL}/PublicExport/Manifest/${this.endpoints.find(e =>
						e.startsWith(`Export${endpoint}`)
					)}`
				)
			).text()
		);
	}

	async fetchEndpoints() {
		this.endpoints = lzma
			.decompress(
				Buffer.from(
					await (
						await fetch(`${API_URL}/PublicExport/index_en.txt.lzma`)
					).arrayBuffer()
				)
			)
			.split("\n");
	}

	parseDamagedJSON(json) {
		return JSON.parse(json.replace(/\\r|\r?\n/g, ""));
	}
}

(async () => {
	const startTime = Date.now();

	let existingItems;
	try {
		existingItems = JSON.parse(await fs.readFile("items.json", "utf8"));
	} catch (e) {
		existingItems = await (
			await fetch(
				"https://firebasestorage.googleapis.com/v0/b/framehub-f9cfb.appspot.com/o/items.json?alt=media"
			)
		).json();
	}

	const updater = new ItemUpdater(OVERWRITES, BLACKLIST);
	await updater.run();

	const difference = jsonDiff.diffString(
		existingItems,
		updater.processedItems
	);
	if (difference || process.env.FORCE_UPLOAD === "true") {
		await fs.writeFile(
			"items.json",
			JSON.stringify(updater.processedItems)
		);
		console.log(difference);

		if (process.env.DISCORD_WEBHOOK && process.env.DISCORD_ADMIN_IDS) {
			const colorlessDifference = difference.replace(
				/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
				""
			);

			const hook = new Webhook(process.env.DISCORD_WEBHOOK);
			const messageTemplate = "```diff\n${MESSAGE}```";
			const chunkSize =
				2000 - messageTemplate.replace("${MESSAGE}", "").length;
			const chunkCount = Math.ceil(
				colorlessDifference.length / chunkSize
			);

			const chunks = [
				process.env.DISCORD_ADMIN_IDS.split(",")
					.map(id => `<@${id}>`)
					.join(" ")
			];
			for (let i = 0; i < chunkCount; i++) {
				chunks.push(
					messageTemplate.replace(
						"${MESSAGE}",
						colorlessDifference.slice(i * chunkSize, chunkSize)
					)
				);
			}

			for (const chunk of chunks) await hook.send(chunk);
		}
	}
	console.log(`Completed in ${(Date.now() - startTime) / 1000} seconds.`);
	process.stdout.write(
		`::set-output name=updated::${
			difference.length > 0 || process.env.FORCE_UPLOAD === "true"
		}`
	);
})();
