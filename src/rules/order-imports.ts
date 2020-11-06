import {
	determineImportType,
	isRegularExpressionGroup,
	ValidImportType,
	KnownImportType,
	RegExpGroups,
} from '../util/import-type';
import { isStaticRequire } from '../util/static-require';

type NewLinesBetweenOption = 'ignore' | 'always' | 'always-and-inside-groups' | 'never';
const newLinesBetweenOptions: NewLinesBetweenOption[] = ['ignore', 'always', 'always-and-inside-groups', 'never'];

type AlphabetizeOption = 'ignore' | 'asc' | 'desc';
type AlphabetizeConfig = { order: AlphabetizeOption; ignoreCase: boolean };
const alphabetizeOptions: AlphabetizeOption[] = ['ignore', 'asc', 'desc'];

type KnownOrders = 'name' | 'kind';
type OrderByItem = { type: KnownOrders, direction?: AlphabetizeOption };
type SortConfig = { orderBy: (KnownOrders | OrderByItem)[]; ignoreCase: boolean };
type NormalizedSortConfig = { orderBy: OrderByItem[]; ignoreCase: boolean };
const sortOrderings: KnownOrders[] = [ 'kind', 'name' ];

type Groups = (ValidImportType | ValidImportType[])[];
const defaultGroups: Groups = ['absolute', 'module', 'parent', 'sibling', 'index'];

type RuleOptions = {
	groups?: Groups;
	newlinesBetween?: NewLinesBetweenOption;
	alphabetize?: Partial<AlphabetizeConfig>;
	sort?: Partial<SortConfig>;
};

type ImportType = 'require' | 'import';

type NodeOrToken = any; // todo;

type Ranks = { [group: string]: number };
type Kinds = 'value' | 'type';
type Imported = { name: string; rank: number; kind?: Kinds; node: NodeOrToken };

type Optional<T> = T | undefined;

// REPORTING AND FIXING

function reverse(array: Imported[]) {
	return array
		.map(function(v) {
			return {
				name: v.name,
				rank: -v.rank,
				node: v.node,
			};
		})
		.reverse();
}

function getTokensOrCommentsAfter(sourceCode, node, count): NodeOrToken[] {
	let currentNodeOrToken = node;
	const result: NodeOrToken = [];
	for (let i = 0; i < count; i++) {
		currentNodeOrToken = sourceCode.getTokenOrCommentAfter(currentNodeOrToken);
		if (currentNodeOrToken == null) {
			break;
		}
		result.push(currentNodeOrToken);
	}
	return result;
}

function getTokensOrCommentsBefore(sourceCode, node, count): NodeOrToken[] {
	let currentNodeOrToken = node;
	const result: NodeOrToken = [];
	for (let i = 0; i < count; i++) {
		currentNodeOrToken = sourceCode.getTokenOrCommentBefore(currentNodeOrToken);
		if (currentNodeOrToken == null) {
			break;
		}
		result.push(currentNodeOrToken);
	}
	return result.reverse();
}

function takeTokensAfterWhile(sourceCode, node, condition): NodeOrToken[] {
	const tokens: NodeOrToken[] = getTokensOrCommentsAfter(sourceCode, node, 100);
	const result: NodeOrToken = [];
	for (let i = 0; i < tokens.length; i++) {
		if (condition(tokens[i])) {
			result.push(tokens[i]);
		} else {
			break;
		}
	}
	return result;
}

function takeTokensBeforeWhile(sourceCode, node, condition): NodeOrToken[] {
	const tokens: NodeOrToken[] = getTokensOrCommentsBefore(sourceCode, node, 100);
	const result: NodeOrToken[] = [];
	for (let i = tokens.length - 1; i >= 0; i--) {
		if (condition(tokens[i])) {
			result.push(tokens[i]);
		} else {
			break;
		}
	}
	return result.reverse();
}

function findOutOfOrder(imported) {
	if (imported.length === 0) {
		return [];
	}
	let maxSeenRankNode = imported[0];
	return imported.filter(function(importedModule) {
		const res = importedModule.rank < maxSeenRankNode.rank;
		if (maxSeenRankNode.rank < importedModule.rank) {
			maxSeenRankNode = importedModule;
		}
		return res;
	});
}

function findRootNode(node) {
	let parent = node;
	while (parent.parent != null && parent.parent.body == null) {
		parent = parent.parent;
	}
	return parent;
}

function findEndOfLineWithComments(sourceCode, node) {
	const tokensToEndOfLine = takeTokensAfterWhile(sourceCode, node, commentOnSameLineAs(node));
	let endOfTokens =
		tokensToEndOfLine.length > 0 ? tokensToEndOfLine[tokensToEndOfLine.length - 1].range[1] : node.range[1];
	let result = endOfTokens;
	for (let i = endOfTokens; i < sourceCode.text.length; i++) {
		if (sourceCode.text[i] === '\n') {
			result = i + 1;
			break;
		}
		if (sourceCode.text[i] !== ' ' && sourceCode.text[i] !== '\t' && sourceCode.text[i] !== '\r') {
			break;
		}
		result = i + 1;
	}
	return result;
}

function commentOnSameLineAs(node): (token: NodeOrToken) => boolean {
	return (token) =>
		(token.type === 'Block' || token.type === 'Line') &&
		token.loc.start.line === token.loc.end.line &&
		token.loc.end.line === node.loc.end.line;
}

function findStartOfLineWithComments(sourceCode, node) {
	const tokensToEndOfLine = takeTokensBeforeWhile(sourceCode, node, commentOnSameLineAs(node));
	let startOfTokens = tokensToEndOfLine.length > 0 ? tokensToEndOfLine[0].range[0] : node.range[0];
	let result = startOfTokens;
	for (let i = startOfTokens - 1; i > 0; i--) {
		if (sourceCode.text[i] !== ' ' && sourceCode.text[i] !== '\t') {
			break;
		}
		result = i;
	}
	return result;
}

function isPlainRequireModule(node): boolean {
	if (node.type !== 'VariableDeclaration') {
		return false;
	}
	if (node.declarations.length !== 1) {
		return false;
	}
	const decl = node.declarations[0];

	return (
		decl.id != null &&
		decl.id.type === 'Identifier' &&
		decl.init != null &&
		decl.init.type === 'CallExpression' &&
		decl.init.callee != null &&
		decl.init.callee.name === 'require' &&
		decl.init.arguments != null &&
		decl.init.arguments.length === 1 &&
		decl.init.arguments[0].type === 'Literal'
	);
}

function isPlainImportModule(node: NodeOrToken): boolean {
	return node.type === 'ImportDeclaration' && node.specifiers != null && node.specifiers.length > 0;
}

function canCrossNodeWhileReorder(node: NodeOrToken): boolean {
	return isPlainRequireModule(node) || isPlainImportModule(node);
}

function canReorderItems(firstNode: NodeOrToken, secondNode: NodeOrToken): boolean {
	const parent = firstNode.parent;
	const firstIndex = parent.body.indexOf(firstNode);
	const secondIndex = parent.body.indexOf(secondNode);
	const nodesBetween = parent.body.slice(firstIndex, secondIndex + 1);
	for (var nodeBetween of nodesBetween) {
		if (!canCrossNodeWhileReorder(nodeBetween)) {
			return false;
		}
	}
	return true;
}

function fixOutOfOrder(context, firstNode: NodeOrToken, secondNode: NodeOrToken, order: 'before' | 'after'): void {
	const sourceCode = context.getSourceCode();

	const firstRoot = findRootNode(firstNode.node);
	const firstRootStart = findStartOfLineWithComments(sourceCode, firstRoot);
	const firstRootEnd = findEndOfLineWithComments(sourceCode, firstRoot);

	const secondRoot = findRootNode(secondNode.node);
	const secondRootStart = findStartOfLineWithComments(sourceCode, secondRoot);
	const secondRootEnd = findEndOfLineWithComments(sourceCode, secondRoot);
	const canFix = canReorderItems(firstRoot, secondRoot);

	let newCode = sourceCode.text.substring(secondRootStart, secondRootEnd);
	if (newCode[newCode.length - 1] !== '\n') {
		newCode = newCode + '\n';
	}

	const message = '`' + secondNode.name + '` import should occur ' + order + ' import of `' + firstNode.name + '`';

	if (order === 'before') {
		context.report({
			node: secondNode.node,
			message: message,
			fix:
				canFix &&
				((fixer) =>
					fixer.replaceTextRange(
						[firstRootStart, secondRootEnd],
						newCode + sourceCode.text.substring(firstRootStart, secondRootStart)
					)),
		});
	} else if (order === 'after') {
		context.report({
			node: secondNode.node,
			message: message,
			fix:
				canFix &&
				((fixer) =>
					fixer.replaceTextRange(
						[secondRootStart, firstRootEnd],
						sourceCode.text.substring(secondRootEnd, firstRootEnd) + newCode
					)),
		});
	}
}

function reportOutOfOrder(context, imported: Imported[], outOfOrder, order: 'before' | 'after'): void {
	outOfOrder.forEach(function(imp) {
		const found = imported.find(function hasHigherRank(importedItem) {
			return importedItem.rank > imp.rank;
		});
		fixOutOfOrder(context, found, imp, order);
	});
}

function makeOutOfOrderReport(context, imported: Imported[]) {
	const outOfOrder = findOutOfOrder(imported);
	if (!outOfOrder.length) {
		return;
	}
	// There are things to report. Try to minimize the number of reported errors.
	const reversedImported = reverse(imported);
	const reversedOrder = findOutOfOrder(reversedImported);
	if (reversedOrder.length < outOfOrder.length) {
		reportOutOfOrder(context, reversedImported, reversedOrder, 'after');
		return;
	}
	reportOutOfOrder(context, imported, outOfOrder, 'before');
}

function getComparator(orderBy: OrderByItem[], ignoreCase: boolean) {
	const fields = orderBy.filter(x => x.direction !== 'ignore');

	const compareKind = function (a: Kinds = 'value', b: Kinds = 'value'): -1 | 0 | 1 {
		return (a === b)
				? 0
				: (a === 'value')
					? -1
					: 1
	}

	const compareString = function (a: string, b: string): number {
		return ignoreCase
			? a.localeCompare(b)
			: a < b
				? -1
				: a === b
					? 0
					: 1;
	}

	return function (a: Imported, b: Imported): -1 | 0 | 1 {
		for (const item of fields) {
			let current = item.type === 'kind'
				? compareKind(a.kind, b.kind)
				: compareString(a.name, b.name)

			if (item.direction === 'desc') {
				current = -current;
			}

			if (current !== 0) {
				return current < 0
					? -1
					: current > 0
						? 1
						: 0;
			}

			// otherwise, continue to the next field
		}

		// if we've gone through all the fields and can't tell the difference,
		// they're the same.
		return 0;
	}
}

function uniqueKey(item: Imported): string {
	return item.rank.toString() + item.kind + item.name;
}

function mutateRanksToSort(imported: Imported[], sortConfig: NormalizedSortConfig) {
	const groupedByRanks = imported.reduce(function(acc, importedItem) {
		acc[importedItem.rank] = acc[importedItem.rank] || [];
		acc[importedItem.rank].push(importedItem);
		return acc;
	}, { } as Record<string, Imported[]>);

	const groupRanks = Object.keys(groupedByRanks);

	// sort imports locally within their group
	groupRanks.forEach(function(groupRank) {
		groupedByRanks[groupRank]
			.sort(
				getComparator(sortConfig.orderBy, sortConfig.ignoreCase)
			);
	});

	// add decimal ranking to sort within the group
	const sortedRanks = groupRanks.sort().reduce(function(acc, groupRank) {
		groupedByRanks[groupRank].forEach(function(imported, index) {
			const key = uniqueKey(imported);
			acc[key] = +groupRank + index / 100;
		});
		return acc;
	}, { } as Record<string, number>);

	// mutate the original group-rank with alphabetized-rank
	imported.forEach(function(importedItem) {
		const key = uniqueKey(importedItem);
		importedItem.rank = sortedRanks[key];
	});
}

function getRegExpGroups(ranks: Ranks): RegExpGroups {
	return Object.keys(ranks)
		.filter(isRegularExpressionGroup)
		.map((rank): [string, RegExp] => [rank, new RegExp(rank.slice(1, rank.length - 1))]);
}

// DETECTING

function computeRank(ranks: Ranks, regExpGroups: RegExpGroups, name: string, type: ImportType): number {
	return ranks[determineImportType(name, regExpGroups)] + (type === 'import' ? 0 : 100);
}

function registerNode(node: NodeOrToken, name: string, type: ImportType, ranks: Ranks, regExpGroups: RegExpGroups, imported: Imported[]) {
	const rank = computeRank(ranks, regExpGroups, name, type);
	if (rank !== -1) {
		imported.push({ name, rank, node, kind: node.importKind });
	}
}

function isInVariableDeclarator(node: NodeOrToken): boolean {
	return node && (node.type === 'VariableDeclarator' || isInVariableDeclarator(node.parent));
}

const knownTypes: KnownImportType[] = ['absolute', 'module', 'parent', 'sibling', 'index'];

// Creates an object with type-rank pairs.
// Example: { index: 0, sibling: 1, parent: 1, module: 2 }
// Will throw an error if it: contains a type that does not exist in the list, does not start and end with '/', or has a duplicate
function convertGroupsToRanks(groups: Groups): Ranks {
	const rankObject = groups.reduce(function(res, group, index) {
		if (typeof group === 'string') group = [group]; // wrap them all in arrays
		group.forEach(function(groupItem: ValidImportType) {
			if (!isRegularExpressionGroup(groupItem) && knownTypes.indexOf(groupItem as KnownImportType) === -1) {
				throw new Error(
					`Incorrect configuration of the rule: Unknown type ${JSON.stringify(
						groupItem
					)}. For a regular expression, wrap the string in '/', ex: '/shared/'`
				);
			}
			if (res[groupItem] !== undefined) {
				throw new Error('Incorrect configuration of the rule: `' + groupItem + '` is duplicated');
			}
			res[groupItem] = index;
		});
		return res;
	}, {});

	const omittedTypes = knownTypes.filter(function(type) {
		return rankObject[type] === undefined;
	});

	return omittedTypes.reduce(function(res, type) {
		res[type] = groups.length;
		return res;
	}, rankObject);
}

function fixNewLineAfterImport(context, previousImport) {
	const prevRoot = findRootNode(previousImport.node);
	const tokensToEndOfLine = takeTokensAfterWhile(context.getSourceCode(), prevRoot, commentOnSameLineAs(prevRoot));

	let endOfLine = prevRoot.range[1];
	if (tokensToEndOfLine.length > 0) {
		endOfLine = tokensToEndOfLine[tokensToEndOfLine.length - 1].range[1];
	}
	return (fixer) => fixer.insertTextAfterRange([prevRoot.range[0], endOfLine], '\n');
}

function removeNewLineAfterImport(context, currentImport, previousImport) {
	const sourceCode = context.getSourceCode();
	const prevRoot = findRootNode(previousImport.node);
	const currRoot = findRootNode(currentImport.node);
	const rangeToRemove = [
		findEndOfLineWithComments(sourceCode, prevRoot),
		findStartOfLineWithComments(sourceCode, currRoot),
	];
	if (/^\s*$/.test(sourceCode.text.substring(rangeToRemove[0], rangeToRemove[1]))) {
		return (fixer) => fixer.removeRange(rangeToRemove);
	}
	return undefined;
}

function makeNewlinesBetweenReport(
	context: any,
	imported: Imported[],
	newlinesBetweenImports: NewLinesBetweenOption
): void {
	const getNumberOfEmptyLinesBetween = (currentImport: Imported, previousImport: Imported): number => {
		const linesBetweenImports = context
			.getSourceCode()
			.lines.slice(previousImport.node.loc.end.line, currentImport.node.loc.start.line - 1);

		return linesBetweenImports.filter((line: any) => !line.trim().length).length;
	};
	let previousImport = imported[0];

	imported.slice(1).forEach(function(currentImport) {
		const emptyLinesBetween: number = getNumberOfEmptyLinesBetween(currentImport, previousImport);

		const currentGroupRank = Math.floor(currentImport.rank); // each group rank is a whole number, within a group, decimals indicate subranking. yeah, not great.
		const previousGroupRank = Math.floor(previousImport.rank);

		if (newlinesBetweenImports === 'always' || newlinesBetweenImports === 'always-and-inside-groups') {
			if (currentGroupRank !== previousGroupRank && emptyLinesBetween === 0) {
				context.report({
					node: previousImport.node,
					message: 'There should be at least one empty line between import groups',
					fix: fixNewLineAfterImport(context, previousImport),
				});
			} else if (
				currentGroupRank === previousGroupRank &&
				emptyLinesBetween === 0 &&
				newlinesBetweenImports === 'always-and-inside-groups'
			) {
				context.report({
					node: previousImport.node,
					message: 'There should be at least one empty line between imports',
					fix: fixNewLineAfterImport(context, previousImport),
				});
			} else if (
				currentGroupRank === previousGroupRank &&
				emptyLinesBetween > 0 &&
				newlinesBetweenImports !== 'always-and-inside-groups'
			) {
				context.report({
					node: previousImport.node,
					message: 'There should be no empty line within import group',
					fix: removeNewLineAfterImport(context, currentImport, previousImport),
				});
			}
		} else if (emptyLinesBetween > 0) {
			context.report({
				node: previousImport.node,
				message: 'There should be no empty line between import groups',
				fix: removeNewLineAfterImport(context, currentImport, previousImport),
			});
		}

		previousImport = currentImport;
	});
}

function getAlphabetizeConfig(options: RuleOptions): AlphabetizeConfig {
	const alphabetize = options.alphabetize || {};
	const order = alphabetize.order || 'ignore';
	const ignoreCase = alphabetize.ignoreCase || false;

	if (typeof order !== 'string') {
		throw new Error(
			'Incorrect alphabetize config: `order` property should be ' +
				'a string, but `' +
				JSON.stringify(typeof order) +
				'` found instead.'
		);
	} else if (['ignore', 'asc', 'desc'].indexOf(order) === -1) {
		throw new Error(
			'Incorrect alphabetize config: `order` property should be ' +
				'either `ignore`, `asc` or `desc`, but `' +
				JSON.stringify(order) +
				'` found instead.'
		);
	}

	if (typeof ignoreCase !== 'boolean') {
		throw new Error(
			'Incorrect alphabetize config: ignoreCase should be ' +
				'a boolean, but `' +
				JSON.stringify(typeof ignoreCase) +
				'` found instead.'
		);
	}

	return { order, ignoreCase };
}

function getSortConfig(options: RuleOptions): Optional<NormalizedSortConfig> {
	// eslint's option schema will enforce that no more than one of alphabetize
	// and sort is provided, so it's safe to ignore options.sort if
	// options.alphabetize is present.
	if (options.alphabetize) {
		const alphabetize = getAlphabetizeConfig(options);
		if (alphabetize.order === 'ignore') {
			return;
		}
		return {
			orderBy: [ { type: 'name', direction: alphabetize.order } ],
			ignoreCase: alphabetize.ignoreCase
		};
	}

	if (!options.sort) {
		return;
	}

	// validate and return sort config.  eslint has already enforced most of
	// the schema, but it can't enforce uniqueness of "type" within "orderBy".
	if (!options.sort.orderBy || !Array.isArray(options.sort.orderBy)) {
		throw new Error(
			'Incorrect sort config: orderBy should be ' +
				'a list of properties, but `' +
				JSON.stringify(options.sort.orderBy) +
				'` found instead.'
		);
	}

	const found = { };
	const orderBy: OrderByItem[] = [];

	for (let item of options.sort.orderBy) {
		if (typeof item === 'string') {
			item = Object.assign({}, { type: item });
		}

		if (found[item.type]) {
			throw new Error(
				'Incorrect sort config: orderBy types should be ' +
					'unique, but `' +
					JSON.stringify(item.type) +
					'` was duplicated.'
			);
		}

		found[item.type] = true;
		if (item.direction === undefined) {
			item = Object.assign({}, item, { direction: 'asc' });
		}
		if (item.direction !== 'ignore') {
			orderBy.push(item);
		}
	}

	return { orderBy, ignoreCase: !!options.sort.ignoreCase };
}


module.exports = {
	meta: {
		type: 'suggestion',
		docs: {
			url: 'https://github.com/Tibfib/eslint-plugin-import-helpers/blob/master/docs/rules/order-imports.md',
		},

		fixable: 'code',
		schema: [
			{
				type: 'object',
				// if sort is provided, alphabetize must not be, and vice versa
				dependencies: {
					sort: { not: { required: [ 'alphabetize' ] } },
					alphabetize: { not: { required: [ 'sort' ] } },
				},
				properties: {
					groups: {
						type: 'array',
					},
					newlinesBetween: {
						enum: newLinesBetweenOptions,
					},
					sort: {
						type: 'object',
						properties: {
							orderBy: {
								type: 'array',
								minItems: 1,
								maxItems: 2,
								uniqueItems: true,
								items: {
									oneOf: [{
										type: 'object',
										properties: {
											type: {
												enum: sortOrderings
											},
											direction: {
												enum: alphabetizeOptions
											}
										}
									}, {
										enum: sortOrderings
									}]
								}
							}
						}
					},
					alphabetize: {
						type: 'object',
						properties: {
							order: {
								enum: alphabetizeOptions,
								default: 'ignore',
							},
							ignoreCase: {
								type: 'boolean',
								default: false,
							},
						},
					},
				},
				additionalProperties: false,
			},
		],
	},

	create: function importOrderRule(context) {
		const options: RuleOptions = context.options[0] || {};
		const newlinesBetweenImports: NewLinesBetweenOption = options.newlinesBetween || 'ignore';

		let sortConfig: Optional<NormalizedSortConfig>;
		let ranks: Ranks;
		let regExpGroups: RegExpGroups;

		try {
			sortConfig = getSortConfig(options);
			ranks = convertGroupsToRanks(options.groups || defaultGroups);
			regExpGroups = getRegExpGroups(ranks);
		} catch (error) {
			// Malformed configuration
			return {
				Program: function(node) {
					context.report(node, error.message);
				},
			};
		}
		let imported: Imported[] = [];

		let level = 0;
		const incrementLevel = () => level++;
		const decrementLevel = () => level--;

		return {
			ImportDeclaration: function handleImports(node) {
				if (node.specifiers.length) {
					// Ignoring unassigned imports
					const name: string = node.source.value;
					registerNode(node, name, 'import', ranks, regExpGroups, imported);
				}
			},
			CallExpression: function handleRequires(node) {
				if (level !== 0 || !isStaticRequire(node) || !isInVariableDeclarator(node.parent)) {
					return;
				}
				const name: string = node.arguments[0].value;
				registerNode(node, name, 'require', ranks, regExpGroups, imported);
			},
			'Program:exit': function reportAndReset() {
				if (sortConfig) {
					mutateRanksToSort(imported, sortConfig);
				}

				makeOutOfOrderReport(context, imported);

				if (newlinesBetweenImports !== 'ignore') {
					makeNewlinesBetweenReport(context, imported, newlinesBetweenImports);
				}

				imported = [];
			},
			FunctionDeclaration: incrementLevel,
			FunctionExpression: incrementLevel,
			ArrowFunctionExpression: incrementLevel,
			BlockStatement: incrementLevel,
			ObjectExpression: incrementLevel,
			'FunctionDeclaration:exit': decrementLevel,
			'FunctionExpression:exit': decrementLevel,
			'ArrowFunctionExpression:exit': decrementLevel,
			'BlockStatement:exit': decrementLevel,
			'ObjectExpression:exit': decrementLevel,
		};
	},
};
