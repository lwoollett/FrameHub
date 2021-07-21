import debounce from "debounce";
import firebase from "firebase/app";
import produce from "immer";
import create from "zustand";
import { firestore } from "../App";
import { ANONYMOUS, SHARED } from "../utils/checklist-types";
import { foundersItems, itemsAsArray } from "../utils/items";
import {
	intrinsicsToXP,
	junctionsToXP,
	missionsToXP,
	totalIntrinsics,
	totalJunctions,
	totalMissions,
	xpFromItem,
	xpToMR
} from "../utils/mastery-rank";

export const useStore = create((set, get) => ({
	type: undefined,
	setType: type => set(() => ({ type })),
	id: undefined,
	setId: id => set(() => ({ id })),
	reset: () => set({ unsavedChanges: [] }),

	unsavedChanges: [],
	saveImmediate: () => {
		const { type, id, unsavedChanges } = get();
		if (type !== SHARED && unsavedChanges.length > 0) {
			let doc = firestore
				.collection(
					type === ANONYMOUS ? "anonymousMasteryData" : "masteryData"
				)
				.doc(id);
			let batch = firestore.batch();

			batch.set(
				doc,
				unsavedChanges
					.filter(change => change.type === "field")
					.reduce((changes, change) => {
						changes[change.field] = change.new;
						return changes;
					}, {}),
				{ merge: true }
			);
			batch.set(
				doc,
				{
					mastered: firebase.firestore.FieldValue.arrayUnion(
						...unsavedChanges
							.filter(
								change =>
									change.type === "item" && change.mastered
							)
							.map(change => change.item)
					)
				},
				{ merge: true }
			);
			batch.set(
				doc,
				{
					mastered: firebase.firestore.FieldValue.arrayRemove(
						...unsavedChanges
							.filter(
								change =>
									change.type === "item" && !change.mastered
							)
							.map(change => change.item)
					)
				},
				{ merge: true }
			);
			batch.set(
				doc,
				{
					partiallyMastered: unsavedChanges
						.filter(change => change.type === "partialItem")
						.reduce((partiallyMastered, change) => {
							partiallyMastered[change.item] =
								change.new ??
								firebase.firestore.FieldValue.delete();
							return partiallyMastered;
						}, {})
				},
				{ merge: true }
			);

			batch.commit();

			set({ unsavedChanges: [] });
		}
	},
	save: debounce(() => get().saveImmediate(), 2500),

	items: {},
	setItems: items => {
		set({ items });
		get().recalculateMasteryRank();
		get().recalculateIngredients();
	},
	fetchItems: async () => {
		if (localStorage.getItem("items")) {
			get().setItems(JSON.parse(localStorage.getItem("items")));
		}

		const { updated } = await firebase
			.storage()
			.ref("items.json")
			.getMetadata();

		if (
			localStorage.getItem("items-updated-at") !== updated ||
			!localStorage.getItem("items")
		) {
			let items = await (
				await fetch(
					"https://firebasestorage.googleapis.com/v0/b/framehub-f9cfb.appspot.com/o/items.json?alt=media"
				)
			).json();
			localStorage.setItem("items", JSON.stringify(items));
			localStorage.setItem("items-updated-at", updated);
			get().setItems(items);
		}
	},

	masteryRank: 0,
	xp: 0,
	itemsMasteredCount: 0,
	totalXP: 0,
	totalItems: 0,
	recalculateMasteryRank: () => {
		const {
			items,
			itemsMastered,
			partiallyMasteredItems,
			missions,
			junctions,
			intrinsics,
			hideFounders
		} = get();

		let xp =
			missionsToXP(missions) +
			junctionsToXP(junctions) +
			intrinsicsToXP(intrinsics);
		let itemsMasteredCount = 0;
		let totalXP =
			missionsToXP(totalMissions) +
			junctionsToXP(totalJunctions) +
			intrinsicsToXP(totalIntrinsics);
		let totalItems = 0;
		itemsAsArray(items).forEach(item => {
			if (itemsMastered.includes(item.name)) {
				xp += xpFromItem(item, item.type);
				itemsMasteredCount++;
			} else if (partiallyMasteredItems[item.name]) {
				xp += xpFromItem(
					item,
					item.type,
					partiallyMasteredItems[item.name]
				);
			}
			if (
				hideFounders &&
				foundersItems.includes(item.name) &&
				!itemsMastered.includes(item.name)
			)
				return;
			totalXP += xpFromItem(item, item.type);
			totalItems++;
		});

		set({
			masteryRank: Math.floor(xpToMR(xp)),
			xp,
			itemsMasteredCount,
			totalXP,
			totalItems
		});
	},

	itemsMastered: [],
	setItemsMastered: itemsMastered => {
		const unsavedChanges = get().unsavedChanges.filter(
			change => change.type === "item"
		);
		const added = unsavedChanges
			.filter(change => change.mastered)
			.map(change => change.item);
		const removed = unsavedChanges
			.filter(change => !change.mastered)
			.map(change => change.item);
		itemsMastered = itemsMastered.filter(item => !removed.includes(item));
		added.forEach(item => {
			if (!itemsMastered.includes(item)) itemsMastered.push(item);
		});

		set(() => ({ itemsMastered }));
		get().recalculateMasteryRank();
		get().recalculateIngredients();
	},
	masterItem: name => {
		set(state =>
			produce(state, draftState => {
				if (draftState.itemsMastered.includes(name)) return;
				draftState.itemsMastered.push(name);
				markItemChange(draftState, name, true);
			})
		);
		get().recalculateMasteryRank();
		get().recalculateIngredients();
		get().save();
	},
	masterAllItems: () => {
		Object.keys(get().partiallyMasteredItems).forEach(item =>
			get().setPartiallyMasteredItem(item, 0)
		);
		set(state =>
			produce(state, draftState => {
				itemsAsArray(draftState.items).forEach(item => {
					if (!draftState.itemsMastered.includes(item.name)) {
						if (
							!state.hideFounders ||
							!foundersItems.includes(item.name)
						) {
							draftState.itemsMastered.push(item.name);
							markItemChange(draftState, item.name, true);
						}
					}
				});
				draftState.ingredients = {};
			})
		);
		get().recalculateMasteryRank();
		get().save();
	},
	unmasterItem: name => {
		set(state =>
			produce(state, draftState => {
				let index = draftState.itemsMastered.indexOf(name);
				if (index === -1) return;

				draftState.itemsMastered.splice(index, 1);
				markItemChange(draftState, name, false);
			})
		);
		get().recalculateMasteryRank();
		get().recalculateIngredients();
		get().save();
	},
	unmasterAllItems: () => {
		Object.keys(get().partiallyMasteredItems).forEach(item =>
			get().setPartiallyMasteredItem(item, 0)
		);
		set(state =>
			produce(state, draftState => {
				state.itemsMastered.forEach(item =>
					markItemChange(draftState, item, false)
				);
				draftState.itemsMastered = [];
			})
		);
		get().recalculateMasteryRank();
		get().recalculateIngredients();
		get().save();
	},

	partiallyMasteredItems: {},
	setPartiallyMasteredItems: partiallyMasteredItems => {
		set(state =>
			produce(state, draftState => {
				state.unsavedChanges
					.filter(change => change.type === "partialItem")
					.forEach(change => {
						partiallyMasteredItems[change.item] = change.rank;
					});
				draftState.partiallyMasteredItems = partiallyMasteredItems;
			})
		);
		get().recalculateMasteryRank();
		get().recalculateIngredients();
		get().save();
	},
	setPartiallyMasteredItem: (name, rank, maxRank) => {
		if (rank === maxRank) get().masterItem(name);
		else if (get().itemsMastered.includes(name)) get().unmasterItem(name);
		rank = rank === maxRank || rank === 0 ? undefined : rank;

		set(state =>
			produce(state, draftState => {
				const existingChangeIndex = state.unsavedChanges.findIndex(
					change =>
						change.type === "partialItem" && change.item === name
				);

				if (existingChangeIndex !== -1) {
					const existingChange =
						draftState.unsavedChanges[existingChangeIndex];
					if (existingChange.old === rank) {
						draftState.unsavedChanges.splice(
							existingChangeIndex,
							1
						);
					} else {
						existingChange.new = rank;
					}
				} else {
					draftState.unsavedChanges.push({
						type: "partialItem",
						item: name,
						old: draftState.partiallyMasteredItems[name],
						new: rank
					});
				}

				if (rank === 0 || rank === maxRank) {
					delete draftState.partiallyMasteredItems[name];
				} else {
					draftState.partiallyMasteredItems[name] = rank;
				}
			})
		);
		get().recalculateMasteryRank();
		get().recalculateIngredients();
		get().save();
	},

	ingredients: {},
	recalculateIngredients: () => {
		const { items, itemsMastered, partiallyMasteredItems } = get();
		const necessaryComponents = {};

		function calculate(recipe) {
			Object.entries(recipe.components).forEach(
				([componentName, component]) => {
					if (component.components) {
						calculate(component);
						return;
					}
					if (component.components || component.generic) return;
					if (!necessaryComponents[componentName])
						necessaryComponents[componentName] = 0;
					necessaryComponents[componentName] += isNaN(component)
						? component.count || 1
						: component;
				}
			);
		}

		itemsAsArray(items).forEach(item => {
			if (
				!itemsMastered.includes(item.name) &&
				!partiallyMasteredItems[item.name] &&
				item.components
			) {
				calculate(item);
			}
		});
		set({ ingredients: necessaryComponents });
	},

	hideMastered: true,
	setHideMastered: (hideMastered, load) =>
		setAndMarkChange(set, load, "hideMastered", hideMastered),
	hideFounders: true,
	setHideFounders: (hideFounders, load) => {
		setAndMarkChange(set, load, "hideFounders", hideFounders);
		get().recalculateMasteryRank();
	},

	missions: 0,
	setMissions: (missions, load) => {
		setAndMarkChange(set, load, "missions", missions);
		get().recalculateMasteryRank();
	},
	junctions: 0,
	setJunctions: (junctions, load) => {
		setAndMarkChange(set, load, "junctions", junctions);
		get().recalculateMasteryRank();
	},
	intrinsics: 0,
	setIntrinsics: (intrinsics, load) => {
		setAndMarkChange(set, load, "intrinsics", intrinsics);
		get().recalculateMasteryRank();
	}
}));

function markItemChange(state, item, mastered) {
	const existingChangeIndex = state.unsavedChanges.findIndex(
		change => change.type === "item" && change.item === item
	);

	if (existingChangeIndex !== -1) {
		state.unsavedChanges.splice(existingChangeIndex, 1);
	} else {
		state.unsavedChanges.push({
			type: "item",
			item,
			mastered
		});
	}
}

function setAndMarkChange(set, load, key, value) {
	set(state =>
		produce(state, draftState => {
			if (state[key] !== value) {
				if (!load) {
					const existingChangeIndex =
						draftState.unsavedChanges.findIndex(
							change =>
								change.type === "field" && change.field === key
						);
					if (existingChangeIndex !== -1) {
						const existingChange =
							draftState.unsavedChanges[existingChangeIndex];
						if (existingChange.old === value) {
							draftState.unsavedChanges.splice(
								existingChangeIndex,
								1
							);
						} else {
							existingChange.new = value;
						}
					} else {
						draftState.unsavedChanges.push({
							type: "field",
							field: key,
							old: state[key],
							new: value
						});
						state.save();
					}
				}
				draftState[key] = value;
			}
		})
	);
}
