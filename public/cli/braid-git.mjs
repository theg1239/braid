#!/usr/bin/env node
// Bundled and transformed by Braid. License notices: ./LICENSE
import { accessSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { availableParallelism, constants as constants$1, homedir, tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
//#region ../node_modules/@stricli/core/dist/index.js
var ExitCode = {
	/**
	* Error was thrown by or otherwise caused by an integration.
	*/
	IntegrationError: -10,
	/**
	* Unable to find a command in the application with the given command line arguments.
	*/
	UnknownCommand: -5,
	/**
	* Unable to parse the specified arguments.
	*/
	InvalidArgument: -4,
	/**
	* An error was thrown while loading the context for a command run.
	*/
	ContextLoadError: -3,
	/**
	* Failed to load command module.
	*/
	CommandLoadError: -2,
	/**
	* An unexpected error was thrown by or not caught by this library.
	*/
	InternalError: -1,
	/**
	* Command executed successfully.
	*/
	Success: 0,
	/**
	* Command module unexpectedly threw an error.
	*/
	CommandRunError: 1
};
function convertKebabCaseToCamelCase(str) {
	return str.replace(/-./g, (match) => match[1].toUpperCase());
}
function convertCamelCaseToKebabCase(name) {
	return Array.from(name).map((char, i) => {
		const upper = char.toUpperCase();
		const lower = char.toLowerCase();
		if (i === 0 || upper !== char || upper === lower) return char;
		return `-${lower}`;
	}).join("");
}
function newSparseMatrix(defaultValue) {
	const values = /* @__PURE__ */ new Map();
	return {
		get: (...args) => {
			return values.get(args.join(",")) ?? defaultValue;
		},
		set: (value, ...args) => {
			values.set(args.join(","), value);
		}
	};
}
function damerauLevenshtein(a, b, options) {
	const { threshold, weights } = options;
	if (a === b) return 0;
	const lengthDiff = Math.abs(a.length - b.length);
	if (typeof threshold === "number" && lengthDiff > threshold) return Infinity;
	const matrix = newSparseMatrix(Infinity);
	matrix.set(0, -1, -1);
	for (let j = 0; j < b.length; ++j) matrix.set((j + 1) * weights.insertion, -1, j);
	for (let i = 0; i < a.length; ++i) matrix.set((i + 1) * weights.deletion, i, -1);
	let prevRowMinDistance = -Infinity;
	for (let i = 0; i < a.length; ++i) {
		let rowMinDistance = Infinity;
		for (let j = 0; j <= b.length - 1; ++j) {
			const cost = a[i] === b[j] ? 0 : 1;
			const distances = [
				matrix.get(i - 1, j) + weights.deletion,
				matrix.get(i, j - 1) + weights.insertion,
				matrix.get(i - 1, j - 1) + cost * weights.substitution
			];
			if (a[i] === b[j - 1] && a[i - 1] === b[j]) distances.push(matrix.get(i - 2, j - 2) + cost * weights.transposition);
			const minDistance = Math.min(...distances);
			matrix.set(minDistance, i, j);
			if (minDistance < rowMinDistance) rowMinDistance = minDistance;
		}
		if (rowMinDistance > threshold) {
			if (prevRowMinDistance > threshold) return Infinity;
			prevRowMinDistance = rowMinDistance;
		} else prevRowMinDistance = -Infinity;
	}
	const distance = matrix.get(a.length - 1, b.length - 1);
	if (distance > threshold) return Infinity;
	return distance;
}
function compareAlternatives(a, b, target) {
	const cmp = a[1] - b[1];
	if (cmp !== 0) return cmp;
	const aStartsWith = a[0].startsWith(target);
	const bStartsWith = b[0].startsWith(target);
	if (aStartsWith && !bStartsWith) return -1;
	else if (!aStartsWith && bStartsWith) return 1;
	return a[0].localeCompare(b[0]);
}
function filterClosestAlternatives(target, alternatives, options) {
	const validAlternatives = alternatives.map((alt) => [alt, damerauLevenshtein(target, alt, options)]).filter(([, dist]) => dist <= options.threshold);
	const minDistance = Math.min(...validAlternatives.map(([, dist]) => dist));
	return validAlternatives.filter(([, dist]) => dist === minDistance).sort((a, b) => compareAlternatives(a, b, target)).map(([alt]) => alt);
}
var InternalError = class extends Error {};
function formatException(exc) {
	if (exc instanceof Error) return exc.stack ?? String(exc);
	return String(exc);
}
function maximum(arr1, arr2) {
	const maxValues = [];
	const maxLength = Math.max(arr1.length, arr2.length);
	for (let i = 0; i < maxLength; ++i) maxValues[i] = Math.max(arr1[i], arr2[i]);
	return maxValues;
}
function formatRowsWithColumns(cells, separators) {
	if (cells.length === 0) return [];
	const startingLengths = Array(Math.max(...cells.map((cellRow) => cellRow.length))).fill(0, 0);
	const maxLengths = cells.reduce((acc, cellRow) => {
		return maximum(acc, cellRow.map((cell) => cell.length));
	}, startingLengths);
	return cells.map((cellRow) => {
		const firstCell = (cellRow[0] ?? "").padEnd(maxLengths[0]);
		return cellRow.slice(1).reduce((parts, str, i, arr) => {
			const paddedStr = arr.length === i + 1 ? str : str.padEnd(maxLengths[i + 1]);
			return [
				...parts,
				separators?.[i] ?? " ",
				paddedStr
			];
		}, [firstCell]).join("").trimEnd();
	});
}
function joinWithGrammar(parts, grammar) {
	if (parts.length <= 1) return parts[0] ?? "";
	if (parts.length === 2) return parts.join(` ${grammar.conjunction} `);
	let allButLast = parts.slice(0, parts.length - 1).join(", ");
	if (grammar.serialComma) allButLast += ",";
	return [
		allButLast,
		grammar.conjunction,
		parts[parts.length - 1]
	].join(" ");
}
function group(array, callback) {
	return array.reduce((groupings, item) => {
		const key = callback(item);
		const groupItems = groupings[key] ?? [];
		groupItems.push(item);
		groupings[key] = groupItems;
		return groupings;
	}, {});
}
function groupBy(array, selector) {
	return group(array, (item) => item[selector]);
}
async function allSettledOrElse(values) {
	const grouped = groupBy(await Promise.allSettled(values), "status");
	if (grouped.rejected && grouped.rejected.length > 0) return {
		status: "rejected",
		reasons: grouped.rejected.map((result) => result.reason)
	};
	return {
		status: "fulfilled",
		value: grouped.fulfilled?.map((result) => result.value) ?? []
	};
}
var TRUTHY_VALUES = /* @__PURE__ */ new Set([
	"true",
	"t",
	"yes",
	"y",
	"on",
	"1",
	""
]);
var FALSY_VALUES = /* @__PURE__ */ new Set([
	"false",
	"f",
	"no",
	"n",
	"off",
	"0"
]);
var looseBooleanParser = (input) => {
	const value = input.toLowerCase();
	if (TRUTHY_VALUES.has(value)) return true;
	if (FALSY_VALUES.has(value)) return false;
	throw new SyntaxError(`Cannot convert ${input} to a boolean`);
};
var numberParser = (input) => {
	const value = Number(input);
	if (Number.isNaN(value)) throw new SyntaxError(`Cannot convert ${input} to a number`);
	return value;
};
var ArgumentScannerError = class extends InternalError {
	_brand;
};
function formatMessageForArgumentScannerError(error, formatter) {
	const formatError = formatter[error.constructor.name];
	if (formatError) return formatError(error);
	return error.message;
}
function resolveAllowedNegationForFlags(flags) {
	return Object.fromEntries(Object.entries(flags).map(([internalFlagName, flag]) => {
		return [internalFlagName, flag.kind === "boolean" && flag.withNegated !== false];
	}));
}
function resolveAliases(flags, aliases, scannerCaseStyle) {
	return Object.fromEntries(Object.entries(aliases).map(([alias, internalFlagName_]) => {
		const internalFlagName = internalFlagName_;
		const flag = flags[internalFlagName];
		if (!flag) throw new FlagNotFoundError(asExternal(internalFlagName, scannerCaseStyle), [], alias);
		return [alias, [internalFlagName, flag]];
	}));
}
var FlagNotFoundError = class extends ArgumentScannerError {
	/**
	* Command line input that triggered this error.
	*/
	input;
	/**
	* Set of proposed suggestions that are similar to the input.
	*/
	corrections;
	/**
	* Set if error was caused indirectly by an alias.
	* This indicates that something is wrong with the command configuration itself.
	*/
	aliasName;
	constructor(input, corrections, aliasName) {
		let message = `No flag registered for --${input}`;
		if (aliasName) message += ` (aliased from -${aliasName})`;
		else if (corrections.length > 0) {
			const formattedCorrections = joinWithGrammar(corrections.map((correction) => `--${correction}`), {
				kind: "conjunctive",
				conjunction: "or",
				serialComma: true
			});
			message += `, did you mean ${formattedCorrections}?`;
		}
		super(message);
		this.input = input;
		this.corrections = corrections;
		this.aliasName = aliasName;
	}
};
var AliasNotFoundError = class extends ArgumentScannerError {
	/**
	* Command line input that triggered this error.
	*/
	input;
	constructor(input) {
		super(`No alias registered for -${input}`);
		this.input = input;
	}
};
function getPlaceholder(param, index) {
	if (param.placeholder) return param.placeholder;
	return typeof index === "number" ? `arg${index}` : "args";
}
function asExternal(internal, scannerCaseStyle) {
	return scannerCaseStyle === "allow-kebab-for-camel" ? convertCamelCaseToKebabCase(internal) : internal;
}
var ArgumentParseError = class extends ArgumentScannerError {
	/**
	* External name of flag or placeholder for positional argument that was parsing this input.
	*/
	externalFlagNameOrPlaceholder;
	/**
	* Command line input that triggered this error.
	*/
	input;
	/**
	* Raw exception thrown from parse function.
	*/
	exception;
	constructor(externalFlagNameOrPlaceholder, input, exception) {
		super(`Failed to parse "${input}" for ${externalFlagNameOrPlaceholder}: ${exception instanceof Error ? exception.message : String(exception)}`);
		this.externalFlagNameOrPlaceholder = externalFlagNameOrPlaceholder;
		this.input = input;
		this.exception = exception;
	}
};
function parseInput(externalFlagNameOrPlaceholder, parameter, input, context) {
	try {
		return parameter.parse.call(context, input);
	} catch (exc) {
		throw new ArgumentParseError(externalFlagNameOrPlaceholder, input, exc);
	}
}
var EnumValidationError = class extends ArgumentScannerError {
	/**
	* External name of flag that was parsing this input.
	*/
	externalFlagName;
	/**
	* Command line input that triggered this error.
	*/
	input;
	/**
	* All possible enum values.
	*/
	values;
	constructor(externalFlagName, input, values, corrections) {
		let message = `Expected "${input}" to be one of (${values.join("|")})`;
		if (corrections.length > 0) {
			const formattedCorrections = joinWithGrammar(corrections.map((str) => `"${str}"`), {
				kind: "conjunctive",
				conjunction: "or",
				serialComma: true
			});
			message += `, did you mean ${formattedCorrections}?`;
		}
		super(message);
		this.externalFlagName = externalFlagName;
		this.input = input;
		this.values = values;
	}
};
var UnsatisfiedFlagError = class extends ArgumentScannerError {
	/**
	* External name of flag that was active when this error was thrown.
	*/
	externalFlagName;
	/**
	* External name of flag that interrupted the original flag.
	*/
	nextFlagName;
	constructor(externalFlagName, nextFlagName) {
		let message = `Expected input for flag --${externalFlagName}`;
		if (nextFlagName) message += ` but encountered --${nextFlagName} instead`;
		super(message);
		this.externalFlagName = externalFlagName;
		this.nextFlagName = nextFlagName;
	}
};
var UnexpectedPositionalError = class extends ArgumentScannerError {
	/**
	* Expected (maximum) count of positional arguments.
	*/
	expectedCount;
	/**
	* Command line input that triggered this error.
	*/
	input;
	constructor(expectedCount, input) {
		super(`Too many arguments, expected ${expectedCount} but encountered "${input}"`);
		this.expectedCount = expectedCount;
		this.input = input;
	}
};
var UnsatisfiedPositionalError = class extends ArgumentScannerError {
	/**
	* Placeholder for positional argument that was active when this error was thrown.
	*/
	placeholder;
	/**
	* If specified, indicates the minimum number of arguments that are expected and the last argument count.
	*/
	limit;
	constructor(placeholder, limit) {
		let message;
		if (limit) {
			message = `Expected at least ${limit[0]} argument(s) for ${placeholder}`;
			if (limit[1] === 0) message += " but found none";
			else message += ` but only found ${limit[1]}`;
		} else message = `Expected argument for ${placeholder}`;
		super(message);
		this.placeholder = placeholder;
		this.limit = limit;
	}
};
function undoNegation(flagName) {
	if (flagName.startsWith("no") && flagName.length > 2) {
		if (flagName[2] === "-") return flagName.slice(4);
		const firstChar = flagName[2];
		if (firstChar !== firstChar.toUpperCase()) return;
		return firstChar.toLowerCase() + flagName.slice(3);
	}
}
function findInternalFlagMatch(externalFlagName, flags, allowsNegation, config) {
	const internalFlagName = externalFlagName;
	let flag = flags[internalFlagName];
	let foundFlagWithNegatedFalse;
	let foundFlagWithNegatedFalseFromKebabConversion = false;
	if (!flag) {
		const internalWithoutNegation = undoNegation(internalFlagName);
		if (internalWithoutNegation) {
			flag = flags[internalWithoutNegation];
			if (flag) {
				if (allowsNegation[internalWithoutNegation]) return [
					internalWithoutNegation,
					flag,
					true
				];
				else {
					foundFlagWithNegatedFalse = internalWithoutNegation;
					flag = void 0;
				}
			}
		}
	}
	const camelCaseFlagName = convertKebabCaseToCamelCase(externalFlagName);
	if (config.caseStyle === "allow-kebab-for-camel" && !flag) {
		flag = flags[camelCaseFlagName];
		if (flag) return [camelCaseFlagName, flag];
		const camelCaseWithoutNegation = undoNegation(camelCaseFlagName);
		if (camelCaseWithoutNegation) {
			flag = flags[camelCaseWithoutNegation];
			if (flag) {
				if (allowsNegation[camelCaseWithoutNegation]) return [
					camelCaseWithoutNegation,
					flag,
					true
				];
				else {
					foundFlagWithNegatedFalse = camelCaseWithoutNegation;
					foundFlagWithNegatedFalseFromKebabConversion = true;
					flag = void 0;
				}
			}
		}
	}
	if (!flag) {
		if (foundFlagWithNegatedFalse) {
			let correction = foundFlagWithNegatedFalse;
			if (foundFlagWithNegatedFalseFromKebabConversion && externalFlagName.includes("-")) correction = convertCamelCaseToKebabCase(foundFlagWithNegatedFalse);
			throw new FlagNotFoundError(externalFlagName, [correction]);
		}
		if (camelCaseFlagName in flags) throw new FlagNotFoundError(externalFlagName, [camelCaseFlagName]);
		const kebabCaseFlagName = convertCamelCaseToKebabCase(externalFlagName);
		if (kebabCaseFlagName in flags) throw new FlagNotFoundError(externalFlagName, [kebabCaseFlagName]);
		throw new FlagNotFoundError(externalFlagName, filterClosestAlternatives(internalFlagName, Object.keys(flags), config.distanceOptions));
	}
	return [internalFlagName, flag];
}
function isNiladic(namedFlagWithNegation) {
	if (namedFlagWithNegation[1].kind === "boolean" || namedFlagWithNegation[1].kind === "counter") return true;
	return false;
}
var FLAG_SHORTHAND_PATTERN = /^-([a-z]+)$/i;
var FLAG_NAME_PATTERN = /^--([a-z][a-z-.\d_]+)$/i;
function findFlagsByArgument(arg, flags, allowsNegation, resolvedAliases, config) {
	const shorthandMatch = FLAG_SHORTHAND_PATTERN.exec(arg);
	if (shorthandMatch) {
		const batch = shorthandMatch[1];
		return Array.from(batch).map((alias) => {
			const aliasName = alias;
			const namedFlag = resolvedAliases[aliasName];
			if (!namedFlag) throw new AliasNotFoundError(aliasName);
			return namedFlag;
		});
	}
	const flagNameMatch = FLAG_NAME_PATTERN.exec(arg);
	if (flagNameMatch) {
		const externalFlagName = flagNameMatch[1];
		return [findInternalFlagMatch(externalFlagName, flags, allowsNegation, config)];
	}
	return [];
}
var FLAG_NAME_VALUE_PATTERN = /^--([a-z][a-z-.\d_]+)=(.+)$/i;
var ALIAS_VALUE_PATTERN = /^-([a-z])=(.+)$/i;
var InvalidNegatedFlagSyntaxError = class extends ArgumentScannerError {
	/**
	* External name of flag that was active when this error was thrown.
	*/
	externalFlagName;
	/**
	* Input text equivalent to right hand side of input
	*/
	valueText;
	constructor(externalFlagName, valueText) {
		super(`Cannot negate flag --${externalFlagName} and pass "${valueText}" as value`);
		this.externalFlagName = externalFlagName;
		this.valueText = valueText;
	}
};
function findFlagByArgumentWithInput(arg, flags, allowsNegation, resolvedAliases, config) {
	const flagsNameMatch = FLAG_NAME_VALUE_PATTERN.exec(arg);
	if (flagsNameMatch) {
		const externalFlagName = flagsNameMatch[1];
		const namedFlag = findInternalFlagMatch(externalFlagName, flags, allowsNegation, config);
		const valueText = flagsNameMatch[2];
		if (namedFlag[2]) throw new InvalidNegatedFlagSyntaxError(externalFlagName, valueText);
		return [namedFlag, valueText];
	}
	const aliasValueMatch = ALIAS_VALUE_PATTERN.exec(arg);
	if (aliasValueMatch) {
		const aliasName = aliasValueMatch[1];
		const namedFlag = resolvedAliases[aliasName];
		if (!namedFlag) throw new AliasNotFoundError(aliasName);
		return [namedFlag, aliasValueMatch[2]];
	}
}
async function parseInputsForFlag(externalFlagName, flag, inputs, config, context) {
	if (!inputs) {
		if ("default" in flag && typeof flag.default !== "undefined") {
			if (flag.kind === "boolean") return flag.default;
			if (flag.kind === "enum") {
				if ("variadic" in flag && flag.variadic && Array.isArray(flag.default)) {
					const defaultArray = flag.default;
					for (const value of defaultArray) if (!flag.values.includes(value)) {
						const corrections = filterClosestAlternatives(value, flag.values, config.distanceOptions);
						throw new EnumValidationError(externalFlagName, value, flag.values, corrections);
					}
					return flag.default;
				}
				return flag.default;
			}
			if ("variadic" in flag && flag.variadic && Array.isArray(flag.default)) {
				const defaultArray = flag.default;
				return Promise.all(defaultArray.map((input2) => parseInput(externalFlagName, flag, input2, context)));
			}
			return parseInput(externalFlagName, flag, flag.default, context);
		}
		if (flag.optional) return;
		if (flag.kind === "boolean") return false;
		else if (flag.kind === "counter") return 0;
		throw new UnsatisfiedFlagError(externalFlagName);
	}
	if (flag.kind === "counter") return inputs.reduce((total, input2) => {
		try {
			return total + numberParser.call(context, input2);
		} catch (exc) {
			throw new ArgumentParseError(externalFlagName, input2, exc);
		}
	}, 0);
	if ("variadic" in flag && flag.variadic) {
		if (flag.kind === "enum") {
			for (const input2 of inputs) if (!flag.values.includes(input2)) {
				const corrections = filterClosestAlternatives(input2, flag.values, config.distanceOptions);
				throw new EnumValidationError(externalFlagName, input2, flag.values, corrections);
			}
			return inputs;
		}
		return Promise.all(inputs.map((input2) => parseInput(externalFlagName, flag, input2, context)));
	}
	const input = inputs[0];
	if (flag.kind === "boolean") try {
		return looseBooleanParser.call(context, input);
	} catch (exc) {
		throw new ArgumentParseError(externalFlagName, input, exc);
	}
	if (flag.kind === "enum") {
		if (!flag.values.includes(input)) {
			const corrections = filterClosestAlternatives(input, flag.values, config.distanceOptions);
			throw new EnumValidationError(externalFlagName, input, flag.values, corrections);
		}
		return input;
	}
	return parseInput(externalFlagName, flag, input, context);
}
var UnexpectedFlagError = class extends ArgumentScannerError {
	/**
	* External name of flag that was parsing this input.
	*/
	externalFlagName;
	/**
	* Command line input that was previously encountered by this flag.
	*/
	previousInput;
	/**
	* Command line input that triggered this error.
	*/
	input;
	constructor(externalFlagName, previousInput, input) {
		super(`Too many arguments for --${externalFlagName}, encountered "${input}" after "${previousInput}"`);
		this.externalFlagName = externalFlagName;
		this.previousInput = previousInput;
		this.input = input;
	}
};
function isVariadicFlag(flag) {
	if (flag.kind === "counter") return true;
	if ("variadic" in flag) return Boolean(flag.variadic);
	return false;
}
function storeInput(flagInputs, scannerCaseStyle, [internalFlagName, flag], input) {
	const inputs = flagInputs.get(internalFlagName) ?? [];
	if (inputs.length > 0 && !isVariadicFlag(flag)) throw new UnexpectedFlagError(asExternal(internalFlagName, scannerCaseStyle), inputs[0], input);
	if ("variadic" in flag && typeof flag.variadic === "string") {
		const multipleInputs = input.split(flag.variadic);
		flagInputs.set(internalFlagName, [...inputs, ...multipleInputs]);
	} else flagInputs.set(internalFlagName, [...inputs, input]);
}
function isFlagSatisfiedByInputs(flags, flagInputs, key) {
	if (flagInputs.get(key)) {
		const flag = flags[key];
		if (isVariadicFlag(flag)) return false;
		return true;
	}
	return false;
}
function buildArgumentScanner(parameters, config) {
	const { flags = {}, aliases = {}, positional = {
		kind: "tuple",
		parameters: []
	} } = parameters;
	const allowsNegation = resolveAllowedNegationForFlags(flags);
	const resolvedAliases = resolveAliases(flags, aliases, config.caseStyle);
	const positionalInputs = [];
	const flagInputs = /* @__PURE__ */ new Map();
	let positionalIndex = 0;
	let activeFlag;
	let treatInputsAsArguments = false;
	return {
		next: (input) => {
			if (!treatInputsAsArguments && config.allowArgumentEscapeSequence && input === "--") {
				if (activeFlag) {
					if (activeFlag[1].kind === "parsed" && activeFlag[1].inferEmpty) {
						storeInput(flagInputs, config.caseStyle, activeFlag, "");
						activeFlag = void 0;
					} else throw new UnsatisfiedFlagError(asExternal(activeFlag[0], config.caseStyle));
				}
				treatInputsAsArguments = true;
				return;
			}
			if (!treatInputsAsArguments) {
				const flagInput = findFlagByArgumentWithInput(input, flags, allowsNegation, resolvedAliases, config);
				if (flagInput) {
					if (activeFlag) {
						if (activeFlag[1].kind === "parsed" && activeFlag[1].inferEmpty) {
							storeInput(flagInputs, config.caseStyle, activeFlag, "");
							activeFlag = void 0;
						} else throw new UnsatisfiedFlagError(asExternal(activeFlag[0], config.caseStyle), asExternal(flagInput[0][0], config.caseStyle));
					}
					storeInput(flagInputs, config.caseStyle, ...flagInput);
					return;
				}
				const nextFlags = findFlagsByArgument(input, flags, allowsNegation, resolvedAliases, config);
				if (nextFlags.length > 0) {
					if (activeFlag) {
						if (activeFlag[1].kind === "parsed" && activeFlag[1].inferEmpty) {
							storeInput(flagInputs, config.caseStyle, activeFlag, "");
							activeFlag = void 0;
						} else throw new UnsatisfiedFlagError(asExternal(activeFlag[0], config.caseStyle), asExternal(nextFlags[0][0], config.caseStyle));
					}
					if (nextFlags.every(isNiladic)) for (const nextFlag of nextFlags) if (nextFlag[1].kind === "boolean") storeInput(flagInputs, config.caseStyle, nextFlag, nextFlag[2] ? "false" : "true");
					else storeInput(flagInputs, config.caseStyle, nextFlag, "1");
					else if (nextFlags.length > 1) throw new UnsatisfiedFlagError(asExternal(nextFlags.find((nextFlag) => !isNiladic(nextFlag))[0], config.caseStyle));
					else activeFlag = nextFlags[0];
					return;
				}
			}
			if (activeFlag) {
				storeInput(flagInputs, config.caseStyle, activeFlag, input);
				activeFlag = void 0;
			} else {
				if (positional.kind === "tuple") {
					if (positionalIndex >= positional.parameters.length) throw new UnexpectedPositionalError(positional.parameters.length, input);
				} else if (typeof positional.maximum === "number" && positionalIndex >= positional.maximum) throw new UnexpectedPositionalError(positional.maximum, input);
				positionalInputs[positionalIndex] = input;
				++positionalIndex;
			}
		},
		parseArguments: async (context) => {
			const errors = [];
			let positionalValues_p;
			if (positional.kind === "array") {
				if (typeof positional.minimum === "number" && positionalIndex < positional.minimum) errors.push(new UnsatisfiedPositionalError(getPlaceholder(positional.parameter), [positional.minimum, positionalIndex]));
				positionalValues_p = allSettledOrElse(positionalInputs.map(async (input, i) => {
					return parseInput(getPlaceholder(positional.parameter, i + 1), positional.parameter, input, context);
				}));
			} else positionalValues_p = allSettledOrElse(positional.parameters.map(async (param, i) => {
				const placeholder = getPlaceholder(param, i + 1);
				const input = positionalInputs[i];
				if (typeof input !== "string") {
					if (typeof param.default === "string") return parseInput(placeholder, param, param.default, context);
					if (param.optional) return;
					throw new UnsatisfiedPositionalError(placeholder);
				}
				return parseInput(placeholder, param, input, context);
			}));
			if (activeFlag && activeFlag[1].kind === "parsed" && activeFlag[1].inferEmpty) {
				storeInput(flagInputs, config.caseStyle, activeFlag, "");
				activeFlag = void 0;
			}
			const flagEntries_p = allSettledOrElse(Object.entries(flags).map(async (entry) => {
				const [internalFlagName, flag] = entry;
				const externalFlagName = asExternal(internalFlagName, config.caseStyle);
				if (activeFlag && activeFlag[0] === internalFlagName) throw new UnsatisfiedFlagError(externalFlagName);
				return [internalFlagName, await parseInputsForFlag(externalFlagName, flag, flagInputs.get(internalFlagName), config, context)];
			}));
			const [positionalValuesResult, flagEntriesResult] = await Promise.all([positionalValues_p, flagEntries_p]);
			if (positionalValuesResult.status === "rejected") for (const reason of positionalValuesResult.reasons) errors.push(reason);
			if (flagEntriesResult.status === "rejected") for (const reason of flagEntriesResult.reasons) errors.push(reason);
			if (errors.length > 0) return {
				success: false,
				errors
			};
			if (positionalValuesResult.status === "rejected") throw new InternalError("Unknown failure while scanning positional arguments");
			if (flagEntriesResult.status === "rejected") throw new InternalError("Unknown failure while scanning flag arguments");
			return {
				success: true,
				arguments: [Object.fromEntries(flagEntriesResult.value), ...positionalValuesResult.value]
			};
		},
		proposeCompletions: async ({ partial, completionConfig, text, context }) => {
			if (activeFlag) return proposeFlagCompletionsForPartialInput(activeFlag[1], context, partial);
			const completions = [];
			if (!treatInputsAsArguments) {
				const shorthandMatch = FLAG_SHORTHAND_PATTERN.exec(partial);
				if (completionConfig.includeAliases) {
					if (partial === "" || partial === "-") {
						const incompleteAliases = Object.entries(aliases).filter((entry) => !isFlagSatisfiedByInputs(flags, flagInputs, entry[1]));
						for (const [alias] of incompleteAliases) {
							const flag = resolvedAliases[alias];
							if (flag) completions.push({
								kind: "argument:flag",
								completion: `-${alias}`,
								brief: flag[1].brief
							});
						}
					} else if (shorthandMatch) {
						const partialAliases = Array.from(shorthandMatch[1]);
						const flagInputsIncludingPartial = new Map(flagInputs);
						for (const alias of partialAliases) {
							const namedFlag = resolvedAliases[alias];
							if (!namedFlag) throw new AliasNotFoundError(alias);
							storeInput(flagInputsIncludingPartial, config.caseStyle, namedFlag, namedFlag[1].kind === "boolean" ? "true" : "1");
						}
						const lastAlias = partialAliases[partialAliases.length - 1];
						if (lastAlias) {
							const namedFlag = resolvedAliases[lastAlias];
							if (namedFlag) completions.push({
								kind: "argument:flag",
								completion: partial,
								brief: namedFlag[1].brief
							});
						}
						const incompleteAliases = Object.entries(aliases).filter((entry) => !isFlagSatisfiedByInputs(flags, flagInputsIncludingPartial, entry[1]));
						for (const [alias] of incompleteAliases) {
							const flag = resolvedAliases[alias];
							if (flag) completions.push({
								kind: "argument:flag",
								completion: `${partial}${alias}`,
								brief: flag[1].brief
							});
						}
					}
				}
				if (partial === "" || partial === "-" || partial.startsWith("--")) {
					if (config.allowArgumentEscapeSequence) completions.push({
						kind: "argument:flag",
						completion: "--",
						brief: text.briefs.argumentEscapeSequence
					});
					let incompleteFlags = Object.entries(flags).filter(([flagName]) => !isFlagSatisfiedByInputs(flags, flagInputs, flagName));
					if (config.caseStyle === "allow-kebab-for-camel") incompleteFlags = incompleteFlags.map(([flagName, param]) => {
						return [convertCamelCaseToKebabCase(flagName), param];
					});
					const possibleFlags = incompleteFlags.map(([flagName, param]) => [`--${flagName}`, param]).filter(([flagName]) => flagName.startsWith(partial));
					completions.push(...possibleFlags.map(([name, param]) => {
						return {
							kind: "argument:flag",
							completion: name,
							brief: param.brief
						};
					}));
				}
			}
			if (positional.kind === "array") {
				if (positional.parameter.proposeCompletions) {
					if (typeof positional.maximum !== "number" || positionalIndex < positional.maximum) {
						const positionalCompletions = await positional.parameter.proposeCompletions.call(context, partial);
						completions.push(...positionalCompletions.map((value) => {
							return {
								kind: "argument:value",
								completion: value,
								brief: positional.parameter.brief
							};
						}));
					}
				}
			} else {
				const nextPositional = positional.parameters[positionalIndex];
				if (nextPositional?.proposeCompletions) {
					const positionalCompletions = await nextPositional.proposeCompletions.call(context, partial);
					completions.push(...positionalCompletions.map((value) => {
						return {
							kind: "argument:value",
							completion: value,
							brief: nextPositional.brief
						};
					}));
				}
			}
			return completions.filter(({ completion }) => completion.startsWith(partial));
		}
	};
}
async function proposeFlagCompletionsForPartialInput(flag, context, partial) {
	if (typeof flag.variadic === "string") {
		if (partial.endsWith(flag.variadic)) return proposeFlagCompletionsForPartialInput(flag, context, "");
	}
	let values;
	if (flag.kind === "enum") values = flag.values;
	else if (flag.proposeCompletions) values = await flag.proposeCompletions.call(context, partial);
	else values = [];
	return values.map((value) => {
		return {
			kind: "argument:value",
			completion: value,
			brief: flag.brief
		};
	}).filter(({ completion }) => completion.startsWith(partial));
}
function listAllRouteNamesAndAliasesForScan(routeMap, scannerCaseStyle, config) {
	const displayCaseStyle = scannerCaseStyle === "allow-kebab-for-camel" ? "convert-camel-to-kebab" : scannerCaseStyle;
	let entries = routeMap.getAllEntries();
	if (!config.includeHiddenRoutes) entries = entries.filter((entry) => !entry.hidden);
	return entries.flatMap((entry) => {
		const routeName = entry.name[displayCaseStyle];
		if (config.includeAliases) return [routeName, ...entry.aliases];
		return [routeName];
	});
}
async function runCommand$1({ loader, parameters }, { context, inputs, scannerConfig, errorFormatting, determineExitCode, ansiColorByStream }) {
	let parsedArguments;
	try {
		const scanner = buildArgumentScanner(parameters, scannerConfig);
		for (const input of inputs) scanner.next(input);
		const result = await scanner.parseArguments(context);
		if (result.success) parsedArguments = result.arguments;
		else {
			for (const error of result.errors) {
				const errorMessage = errorFormatting.exceptionWhileParsingArguments(error, ansiColorByStream.stderr);
				context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
			}
			return ExitCode.InvalidArgument;
		}
	} catch (exc) {
		const errorMessage = errorFormatting.exceptionWhileParsingArguments(exc, ansiColorByStream.stderr);
		context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
		return ExitCode.InvalidArgument;
	}
	let commandFunction;
	try {
		const loaded = await loader();
		if (typeof loaded === "function") commandFunction = loaded;
		else commandFunction = loaded.default;
	} catch (exc) {
		const errorMessage = errorFormatting.exceptionWhileLoadingCommandFunction(exc, ansiColorByStream.stderr);
		context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
		return ExitCode.CommandLoadError;
	}
	try {
		const result = await commandFunction.call(context, ...parsedArguments);
		if (result instanceof Error) {
			const errorMessage = errorFormatting.commandErrorResult(result, ansiColorByStream.stderr);
			context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
			if (determineExitCode) return determineExitCode(result);
			return ExitCode.CommandRunError;
		}
	} catch (exc) {
		const errorMessage = errorFormatting.exceptionWhileRunningCommand(exc, ansiColorByStream.stderr);
		context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
		if (determineExitCode) return determineExitCode(exc);
		return ExitCode.CommandRunError;
	}
	return ExitCode.Success;
}
var RouteMapSymbol = Symbol("RouteMap");
var CommandSymbol = Symbol("Command");
function buildRouteScanner(root, config, startingPrefix, additionalFlags) {
	const prefix = [...startingPrefix];
	const unprocessedInputs = [];
	const flags = {};
	for (const additionalFlag of additionalFlags) flags[additionalFlag.name] = additionalFlag;
	const aliases = {};
	for (const additionalFlag of additionalFlags) if (additionalFlag.aliases) for (const alias of additionalFlag.aliases) aliases[alias] = additionalFlag.name;
	const resolvedAliases = resolveAliases(flags, aliases, config.caseStyle);
	let activeFlag;
	let parent;
	let current = root;
	let target;
	let treatInputsAsArguments = false;
	return {
		next: (input) => {
			if (!treatInputsAsArguments && config.allowArgumentEscapeSequence && input === "--") {
				treatInputsAsArguments = true;
				unprocessedInputs.push(input);
				return;
			}
			if (!treatInputsAsArguments && !activeFlag) try {
				const nextFlags = findFlagsByArgument(input, flags, {}, resolvedAliases, config);
				for (const currentFlag of nextFlags) {
					if (!currentFlag[1].global && current !== root) continue;
					activeFlag = currentFlag[1];
					target = current;
					return;
				}
			} catch {}
			if (target || treatInputsAsArguments) {
				unprocessedInputs.push(input);
				return;
			}
			if (current.kind === CommandSymbol) {
				target = current;
				unprocessedInputs.push(input);
				return;
			}
			const camelCaseRouteName = convertKebabCaseToCamelCase(input);
			let internalRouteName = input;
			let next = current.getRoutingTargetForInput(internalRouteName);
			if (config.caseStyle === "allow-kebab-for-camel" && !next) {
				next = current.getRoutingTargetForInput(camelCaseRouteName);
				if (next) internalRouteName = camelCaseRouteName;
			}
			if (!next) {
				const defaultCommand = current.getDefaultCommand();
				unprocessedInputs.push(input);
				if (defaultCommand) {
					parent = [current, ""];
					current = defaultCommand;
					return;
				}
				return {
					input,
					routeMap: current
				};
			}
			parent = [current, input];
			current = next;
			prefix.push(input);
		},
		finish: () => {
			target = target ?? current;
			if (target.kind === RouteMapSymbol && !activeFlag) {
				const defaultCommand = target.getDefaultCommand();
				if (defaultCommand) {
					parent = [target, ""];
					target = defaultCommand;
				}
			}
			const aliases2 = parent ? parent[0].getOtherAliasesForInput(parent[1], config.caseStyle) : {
				original: [],
				"convert-camel-to-kebab": []
			};
			return {
				target,
				unprocessedInputs,
				prefix,
				aliases: aliases2,
				activeFlag
			};
		}
	};
}
function checkEnvironmentVariable(process, varName) {
	const value = process.env?.[varName];
	return typeof value === "string" && looseBooleanParser(value);
}
var text_en = {
	headers: {
		usage: "USAGE",
		aliases: "ALIASES",
		commands: "COMMANDS",
		flags: "FLAGS",
		arguments: "ARGUMENTS"
	},
	keywords: {
		default: "default =",
		separator: "separator ="
	},
	briefs: {
		help: "Print help information and exit",
		helpAll: "Print help information (including hidden commands/flags) and exit",
		version: "Print version information and exit",
		argumentEscapeSequence: "All subsequent inputs should be interpreted as arguments"
	},
	noCommandRegisteredForInput({ input, corrections }) {
		const errorMessage = `No command registered for \`${input}\``;
		if (corrections.length > 0) return `${errorMessage}, did you mean ${joinWithGrammar(corrections, {
			kind: "conjunctive",
			conjunction: "or",
			serialComma: true
		})}?`;
		else return errorMessage;
	},
	noTextAvailableForLocale({ requestedLocale, defaultLocale }) {
		return `Application does not support "${requestedLocale}" locale, defaulting to "${defaultLocale}"`;
	},
	exceptionWhileParsingArguments(exc) {
		if (exc instanceof ArgumentScannerError) return formatMessageForArgumentScannerError(exc, {});
		return `Unable to parse arguments, ${(this.formatException ?? formatException)(exc)}`;
	},
	exceptionWhileLoadingCommandFunction(exc) {
		return `Unable to load command function, ${(this.formatException ?? formatException)(exc)}`;
	},
	exceptionWhileLoadingCommandContext(exc) {
		return `Unable to load command context, ${(this.formatException ?? formatException)(exc)}`;
	},
	exceptionWhileRunningCommand(exc) {
		return `Command failed, ${(this.formatException ?? formatException)(exc)}`;
	},
	exceptionWhileRunningIntegrationHook({ exception, hook, integration }) {
		return `Unexpected exception thrown by '${integration}' integration during '${hook}' hook.
${(this.formatException ?? formatException)(exception)}`;
	},
	exceptionWhileRunningIntegrationFlag({ exception, integration }) {
		return `Unexpected exception thrown by "--${integration}" flag from the '${integration}' integration.
${(this.formatException ?? formatException)(exception)}`;
	},
	commandErrorResult(err) {
		return err.message;
	},
	currentVersionIsNotLatest({ currentVersion, latestVersion, upgradeCommand }) {
		if (upgradeCommand) return `Latest available version is ${latestVersion} (currently running ${currentVersion}), upgrade with "${upgradeCommand}"`;
		return `Latest available version is ${latestVersion} (currently running ${currentVersion})`;
	}
};
function defaultTextLoader(locale) {
	if (locale.startsWith("en")) return text_en;
}
function shouldUseAnsiColor(process, stream, config) {
	return !config.disableAnsiColor && !checkEnvironmentVariable(process, "STRICLI_NO_COLOR") && (stream.getColorDepth?.(process.env) ?? 1) >= 4;
}
function shouldUseAnsiColorForStreams(process, config) {
	return {
		stdout: shouldUseAnsiColor(process, process.stdout, config),
		stderr: shouldUseAnsiColor(process, process.stderr, config)
	};
}
function validateCaseStyleCompatibility(scan, display) {
	if (scan === "original" && display === "convert-camel-to-kebab") throw new Error("Cannot convert route and flag names on display (convert-camel-to-kebab) but scan as original");
}
function help({ alias = "h", includeHidden = false, formatting, ...config }) {
	return {
		validate(_root, config2) {
			validateCaseStyleCompatibility(config2.scanner.caseStyle, formatting.caseStyle);
		},
		flag: {
			...config,
			global: true,
			aliases: alias === false ? [] : [alias],
			async run(app, { text, ansiColorByStream, result, additionalFlags }) {
				this.process.stdout.write(result.target.formatHelp({
					prefix: result.prefix,
					additionalFlags,
					includeArgumentEscapeSequenceFlag: app.config.scanner.allowArgumentEscapeSequence,
					includeHidden,
					config: formatting,
					aliases: result.aliases[formatting.caseStyle],
					text,
					ansiColor: ansiColorByStream.stdout
				}));
			}
		}
	};
}
function version$1({ info, alias = "v", hook = "app:start", ...config }) {
	let versionCheck;
	if (info.getLatestVersion) {
		const getLatestVersion = info.getLatestVersion;
		versionCheck = async function({ text, ansiColorByStream }) {
			if (checkEnvironmentVariable(this.process, "STRICLI_SKIP_VERSION_CHECK")) return;
			let currentVersion;
			if ("currentVersion" in info) currentVersion = info.currentVersion;
			else currentVersion = await info.getCurrentVersion.call(this);
			const latestVersion = await getLatestVersion.call(this, currentVersion);
			if (latestVersion && currentVersion !== latestVersion) {
				const warningMessage = text.currentVersionIsNotLatest({
					currentVersion,
					latestVersion,
					upgradeCommand: info.upgradeCommand,
					ansiColor: ansiColorByStream.stderr
				});
				this.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[33m${warningMessage}\x1B[39m\x1B[22m
` : `${warningMessage}
`);
			}
		};
	}
	return {
		hooks: versionCheck ? { [hook]: versionCheck } : {},
		flag: {
			...config,
			defaultForRouteMap: false,
			global: false,
			aliases: alias === false ? [] : [alias],
			async run() {
				let currentVersion;
				if ("currentVersion" in info) currentVersion = info.currentVersion;
				else currentVersion = await info.getCurrentVersion.call(this);
				this.process.stdout.write(currentVersion + "\n");
			}
		}
	};
}
async function runHook(integrations, hookName, context, args) {
	for (const [name, integration] of Object.entries(integrations)) {
		const hook = integration.hooks?.[hookName];
		if (hook) try {
			await hook.call(context, args);
		} catch (exc) {
			const errorMessage = args.text.exceptionWhileRunningIntegrationHook({
				exception: exc,
				hook: hookName,
				integration: name,
				ansiColor: args.ansiColorByStream.stderr
			});
			context.process.stderr.write(args.ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
			return ExitCode.IntegrationError;
		}
	}
}
function checkIntegrationsForCollisions(integrations, caseStyle) {
	let routeMapDefault;
	const flagNames = new Set(Object.keys(integrations));
	const aliases = /* @__PURE__ */ new Map();
	for (const [name, integration] of Object.entries(integrations)) {
		if (caseStyle === "allow-kebab-for-camel") {
			const camelCase = convertKebabCaseToCamelCase(name);
			if (camelCase !== name && flagNames.has(camelCase)) throw new InternalError(`Multiple integrations are trying to use the same flag name (with 'allow-kebab-for-camel'): '${name}' and '${camelCase}'`);
		}
		if (integration.flag) {
			if (integration.flag.defaultForRouteMap) {
				if (routeMapDefault) throw new InternalError(`Multiple integrations provide a default flag for route maps: '${routeMapDefault}' and '${name}'`);
				routeMapDefault = name;
			}
			for (const alias of integration.flag.aliases ?? []) {
				const flagForAlias = aliases.get(alias);
				if (flagForAlias) throw new InternalError(`Multiple integrations are trying to use the same flag alias "-${alias}": '${flagForAlias}' and '${name}'`);
				aliases.set(alias, name);
			}
		}
	}
}
function checkIntegrationsForFlagNameConflicts(root, additionalFlags, caseStyle) {
	function checkForConflicts(target, prefix) {
		if (target.kind === CommandSymbol) {
			const relevantFlags = root === target ? additionalFlags : additionalFlags.filter(({ global }) => global);
			for (const { name, aliases } of relevantFlags) {
				if (target.usesFlag(name, caseStyle)) throw new InternalError(`'${name}' integration provides a flag that would override: "${[...prefix, `--${name}`].join(" ")}"`);
				for (const alias of aliases ?? []) if (target.usesFlag(alias, caseStyle)) throw new InternalError(`'${name}' integration provides a flag with an alias that would override: "${[...prefix, `-${alias}`].join(" ")}"`);
			}
		} else for (const entry of target.getAllEntries()) checkForConflicts(entry.target, [...prefix, entry.name.original]);
	}
	checkForConflicts(root, []);
}
function gatherAdditionalFlagsFromIntegrations(integrations) {
	const flags = [];
	for (const [name, integration] of Object.entries(integrations)) if (integration.flag) flags.push({
		...integration.flag,
		name
	});
	return flags;
}
function validateIntegrations(integrations, root, config) {
	for (const [name, integration] of Object.entries(integrations)) try {
		integration.validate?.(root, config);
	} catch (exc) {
		throw new InternalError(`Integration '${name}' failed validation: ${String(exc)}`, { cause: exc });
	}
}
function gatherDefaultIntegrations(config, text) {
	const integrations = {
		help: help({
			brief: text.briefs.help,
			alias: "h",
			defaultForRouteMap: true,
			includeHidden: false,
			formatting: config.documentation
		}),
		helpAll: help({
			brief: text.briefs.helpAll,
			alias: "H",
			hidden: !config.documentation.alwaysShowHelpAllFlag,
			includeHidden: true,
			formatting: config.documentation
		})
	};
	if (config.versionInfo) integrations["version"] = version$1({
		brief: text.briefs.version,
		info: config.versionInfo,
		alias: "v",
		hook: "app:start"
	});
	return integrations;
}
async function runApplication(app, rawInputs, context) {
	const ansiColorByStream = shouldUseAnsiColorForStreams(context.process, app.config.documentation);
	let text = app.defaultText;
	if (context.locale && "loadText" in app.config.localization) {
		const localeText = app.config.localization.loadText(context.locale);
		if (localeText) text = localeText;
		else {
			const warningMessage = text.noTextAvailableForLocale({
				requestedLocale: context.locale,
				defaultLocale: app.config.localization.defaultLocale,
				ansiColor: ansiColorByStream.stderr
			});
			context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[33m${warningMessage}\x1B[39m\x1B[22m
` : `${warningMessage}
`);
		}
	}
	const hookStartExitCode = await runHook(app.integrations, "app:start", context, {
		text,
		ansiColorByStream
	});
	if (typeof hookStartExitCode === "number") return hookStartExitCode;
	const exitCode = await scanInputsAndRunTarget(app, rawInputs, context, text, ansiColorByStream);
	const hookEndExitCode = await runHook(app.integrations, "app:end", context, {
		text,
		ansiColorByStream,
		exitCode
	});
	if (typeof hookEndExitCode === "number") return hookEndExitCode;
	return exitCode;
}
async function scanInputsAndRunTarget(app, rawInputs, context, text, ansiColorByStream) {
	const additionalFlags = gatherAdditionalFlagsFromIntegrations(app.integrations);
	const inputs = rawInputs.slice();
	const scanner = buildRouteScanner(app.root, app.config.scanner, [app.config.name], additionalFlags);
	let error;
	while (inputs.length > 0 && !error) {
		const arg = inputs.shift();
		error = scanner.next(arg);
	}
	if (error) {
		const routeNames = listAllRouteNamesAndAliasesForScan(error.routeMap, app.config.scanner.caseStyle, app.config.completion);
		const corrections = filterClosestAlternatives(error.input, routeNames, app.config.scanner.distanceOptions).map((str) => `\`${str}\``);
		const errorMessage = text.noCommandRegisteredForInput({
			input: error.input,
			corrections,
			ansiColor: ansiColorByStream.stderr
		});
		context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
		return ExitCode.UnknownCommand;
	}
	let { activeFlag, ...result } = scanner.finish();
	if (activeFlag || result.target.kind === RouteMapSymbol) {
		if (!activeFlag) activeFlag = additionalFlags.find((flag) => flag.defaultForRouteMap);
		if (activeFlag) {
			let additionalFlagsForTarget = additionalFlags;
			if (result.target !== app.root) additionalFlagsForTarget = additionalFlagsForTarget.filter((flag) => flag.global);
			try {
				await activeFlag.run.call(context, app, {
					text,
					ansiColorByStream,
					result,
					additionalFlags: additionalFlagsForTarget
				});
			} catch (exc) {
				const errorMessage = text.exceptionWhileRunningIntegrationFlag({
					exception: exc,
					ansiColor: ansiColorByStream.stderr,
					integration: activeFlag.name
				});
				context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m
` : `${errorMessage}
`);
				return ExitCode.IntegrationError;
			}
		}
		return ExitCode.Success;
	}
	let commandContext;
	if ("forCommand" in context) try {
		commandContext = await context.forCommand({ prefix: result.prefix });
	} catch (exc) {
		const errorMessage = text.exceptionWhileLoadingCommandContext(exc, ansiColorByStream.stderr);
		context.process.stderr.write(ansiColorByStream.stderr ? `\x1B[1m\x1B[31m${errorMessage}\x1B[39m\x1B[22m` : errorMessage);
		return ExitCode.ContextLoadError;
	}
	else commandContext = context;
	const hookStartExitCode = await runHook(app.integrations, "command:start", commandContext, {
		text,
		ansiColorByStream,
		result
	});
	if (typeof hookStartExitCode === "number") return hookStartExitCode;
	const exitCode = await runCommand$1(result.target, {
		context: commandContext,
		inputs: result.unprocessedInputs,
		scannerConfig: app.config.scanner,
		errorFormatting: text,
		determineExitCode: app.config.determineExitCode,
		ansiColorByStream
	});
	const hookEndExitCode = await runHook(app.integrations, "command:end", commandContext, {
		text,
		ansiColorByStream,
		result,
		exitCode
	});
	if (typeof hookEndExitCode === "number") return hookEndExitCode;
	return exitCode;
}
function hasDefault(flag) {
	return "default" in flag && typeof flag.default !== "undefined";
}
function isOptionalAtRuntime(flag) {
	return flag.optional ?? hasDefault(flag);
}
function withDefaultFormattingConfiguration(config, scannerCaseStyle) {
	let displayCaseStyle;
	if (config.caseStyle) displayCaseStyle = config.caseStyle;
	else if (scannerCaseStyle === "allow-kebab-for-camel") displayCaseStyle = "convert-camel-to-kebab";
	else displayCaseStyle = scannerCaseStyle;
	validateCaseStyleCompatibility(scannerCaseStyle, displayCaseStyle);
	return {
		useAliasInUsageLine: config.useAliasInUsageLine ?? false,
		onlyRequiredInUsageLine: config.onlyRequiredInUsageLine ?? false,
		caseStyle: displayCaseStyle
	};
}
function wrapRequiredFlag(text) {
	return `(${text})`;
}
function wrapOptionalFlag(text) {
	return `[${text}]`;
}
function wrapVariadicFlag(text) {
	return `${text}...`;
}
function wrapRequiredParameter(text) {
	return `<${text}>`;
}
function wrapOptionalParameter(text) {
	return `[<${text}>]`;
}
function wrapVariadicParameter(text) {
	return `<${text}>...`;
}
function formatUsageLineForParameters(parameters, args) {
	const flagsUsage = Object.entries(parameters.flags ?? {}).filter(([, flag]) => {
		if (flag.hidden) return false;
		if (args.config.onlyRequiredInUsageLine && isOptionalAtRuntime(flag)) return false;
		return true;
	}).map(([name, flag]) => {
		let displayName = args.config.caseStyle === "convert-camel-to-kebab" ? `--${convertCamelCaseToKebabCase(name)}` : `--${name}`;
		if (parameters.aliases && args.config.useAliasInUsageLine) {
			const aliases = Object.entries(parameters.aliases).filter((entry) => entry[1] === name);
			if (aliases.length === 1 && aliases[0]) displayName = `-${aliases[0][0]}`;
		}
		if (flag.kind === "boolean") return [flag, displayName];
		if (flag.kind === "enum" && typeof flag.placeholder !== "string") return [flag, `${displayName} ${flag.values.join("|")}`];
		const placeholder = flag.placeholder ?? "value";
		return [flag, `${displayName} ${placeholder}`];
	}).map(([flag, usage]) => {
		if (flag.kind === "parsed" && flag.variadic) {
			if (isOptionalAtRuntime(flag)) return wrapVariadicFlag(wrapOptionalFlag(usage));
			return wrapVariadicFlag(wrapRequiredFlag(usage));
		}
		if (isOptionalAtRuntime(flag)) return wrapOptionalFlag(usage);
		return wrapRequiredFlag(usage);
	});
	let positionalUsage = [];
	const positional = parameters.positional;
	if (positional) {
		if (positional.kind === "array") positionalUsage = [wrapVariadicParameter(positional.parameter.placeholder ?? "args")];
		else {
			let parameters2 = positional.parameters;
			if (args.config.onlyRequiredInUsageLine) parameters2 = parameters2.filter((param) => !param.optional && typeof param.default === "undefined");
			positionalUsage = parameters2.map((param, i) => {
				const argName = param.placeholder ?? `arg${i + 1}`;
				return param.optional || typeof param.default !== "undefined" ? wrapOptionalParameter(argName) : wrapRequiredParameter(argName);
			});
		}
	}
	return [
		...args.prefix,
		...flagsUsage,
		...positionalUsage
	].join(" ");
}
function formatForDisplay(flagName, displayCaseStyle) {
	if (displayCaseStyle === "convert-camel-to-kebab") return convertCamelCaseToKebabCase(flagName);
	return flagName;
}
function formatAsNegated(flagName, displayCaseStyle) {
	if (displayCaseStyle === "convert-camel-to-kebab") return `no-${convertCamelCaseToKebabCase(flagName)}`;
	return `no${flagName[0].toUpperCase()}${flagName.slice(1)}`;
}
function withDefaults(config) {
	const scannerCaseStyle = config.scanner?.caseStyle ?? "original";
	const scannerConfig = {
		caseStyle: scannerCaseStyle,
		allowArgumentEscapeSequence: config.scanner?.allowArgumentEscapeSequence ?? false,
		distanceOptions: config.scanner?.distanceOptions ?? {
			threshold: 7,
			weights: {
				insertion: 1,
				deletion: 3,
				substitution: 2,
				transposition: 0
			}
		}
	};
	const documentationConfig = {
		alwaysShowHelpAllFlag: config.documentation?.alwaysShowHelpAllFlag ?? false,
		disableAnsiColor: config.documentation?.disableAnsiColor ?? false,
		...withDefaultFormattingConfiguration(config.documentation ?? {}, scannerCaseStyle)
	};
	const completionConfig = {
		includeAliases: config.completion?.includeAliases ?? documentationConfig.useAliasInUsageLine,
		includeHiddenRoutes: config.completion?.includeHiddenRoutes ?? false,
		...config.completion
	};
	return {
		...config,
		scanner: scannerConfig,
		completion: completionConfig,
		documentation: documentationConfig,
		localization: {
			defaultLocale: "en",
			loadText: defaultTextLoader,
			...config.localization
		}
	};
}
function buildApplication(root, appConfig, integrations) {
	const config = withDefaults(appConfig);
	let defaultText;
	if ("text" in config.localization) defaultText = config.localization.text;
	else {
		const text = config.localization.loadText(config.localization.defaultLocale);
		if (!text) throw new InternalError(`No text available for the default locale "${config.localization.defaultLocale}"`);
		defaultText = text;
	}
	if (integrations) checkIntegrationsForCollisions(integrations, config.scanner.caseStyle);
	else integrations = gatherDefaultIntegrations(config, defaultText);
	checkIntegrationsForFlagNameConflicts(root, gatherAdditionalFlagsFromIntegrations(integrations), config.scanner.caseStyle);
	validateIntegrations(integrations, root, config);
	return {
		root,
		config,
		defaultText,
		integrations
	};
}
function narrowString(choices, value) {
	return choices.includes(value);
}
function buildChoiceParser(choices) {
	return (input) => {
		if (!narrowString(choices, input)) throw new SyntaxError(`${input} is not one of (${choices.join("|")})`);
		return input;
	};
}
function formatRowForAdditionalFlag(flag, caseStyle) {
	return {
		aliases: flag.aliases ? flag.aliases.map((alias) => `-${alias}`).join(" ") : "",
		flagName: `--${formatForDisplay(flag.name, caseStyle)}`,
		brief: flag.brief,
		hidden: flag.hidden
	};
}
function formatDocumentationForFlagParameters(flags, aliases, args) {
	const { keywords } = args.text;
	const visibleFlags = Object.entries(flags).filter(([, flag]) => {
		if (flag.hidden && !args.includeHidden) return false;
		return true;
	});
	const atLeastOneOptional = visibleFlags.some(([, flag]) => isOptionalAtRuntime(flag));
	const rows = visibleFlags.map(([name, flag]) => {
		const aliasStrings = Object.entries(aliases).filter((entry) => entry[1] === name).map(([alias]) => `-${alias}`);
		let flagName = "--" + formatForDisplay(name, args.config.caseStyle);
		if (flag.kind === "boolean" && flag.default !== false && flag.withNegated !== false) {
			const negatedFlagName = formatAsNegated(name, args.config.caseStyle);
			flagName = `${flagName}/--${negatedFlagName}`;
		}
		if (isOptionalAtRuntime(flag)) flagName = `[${flagName}]`;
		else if (atLeastOneOptional) flagName = ` ${flagName}`;
		if (flag.kind === "parsed" && flag.variadic) flagName = `${flagName}...`;
		const suffixParts = [];
		if (flag.kind === "enum") {
			const choices = flag.values.join("|");
			suffixParts.push(choices);
		}
		if (hasDefault(flag)) {
			const defaultKeyword = args.ansiColor ? `\x1B[2m${keywords.default}\x1B[22m` : keywords.default;
			let defaultValue;
			if (Array.isArray(flag.default)) {
				if (flag.default.length === 0) defaultValue = "[]";
				else {
					const separator = "variadic" in flag && typeof flag.variadic === "string" ? flag.variadic : " ";
					defaultValue = flag.default.join(separator);
				}
			} else defaultValue = flag.default === "" ? `""` : String(flag.default);
			suffixParts.push(`${defaultKeyword} ${defaultValue}`);
		}
		if ("variadic" in flag && typeof flag.variadic === "string") {
			const separatorKeyword = args.ansiColor ? `\x1B[2m${keywords.separator}\x1B[22m` : keywords.separator;
			suffixParts.push(`${separatorKeyword} ${flag.variadic}`);
		}
		const suffix = suffixParts.length > 0 ? `[${suffixParts.join(", ")}]` : void 0;
		return {
			aliases: aliasStrings.join(" "),
			flagName,
			brief: flag.brief,
			suffix,
			hidden: flag.hidden
		};
	});
	for (const flag of args.additionalFlags) {
		if (flag.hidden && !args.includeHidden) continue;
		const row = formatRowForAdditionalFlag(flag, args.config.caseStyle);
		rows.push({
			...row,
			flagName: atLeastOneOptional ? ` ${row.flagName}` : row.flagName
		});
	}
	if (args.includeArgumentEscapeSequenceFlag) rows.push({
		aliases: "",
		flagName: atLeastOneOptional ? " --" : "--",
		brief: args.text.briefs.argumentEscapeSequence
	});
	return formatRowsWithColumns(rows.map((row) => {
		if (!args.ansiColor) return [
			row.aliases,
			row.flagName,
			row.brief,
			row.suffix ?? ""
		];
		return [
			row.hidden ? `\x1B[2m${row.aliases}\x1B[22m` : `\x1B[1m${row.aliases}\x1B[22m`,
			row.hidden ? `\x1B[2m${row.flagName}\x1B[22m` : `\x1B[1m${row.flagName}\x1B[22m`,
			row.hidden ? `\x1B[2;3m${row.brief}\x1B[22;23m` : `\x1B[;;3m${row.brief}\x1B[;;;23m`,
			row.suffix ?? ""
		];
	}), [
		" ",
		"  ",
		" "
	]);
}
function* generateUsageLinesForAdditionalFlags(flags, includeHidden, caseStyle, useAliasInUsageLine) {
	for (const flag of flags) {
		if (flag.hidden && !includeHidden) continue;
		if (useAliasInUsageLine && flag.aliases && flag.aliases.length > 0) yield `-${flag.aliases[0]}`;
		else yield `--${formatForDisplay(flag.name, caseStyle)}`;
	}
}
function formatDocumentationForPositionalParameters(positional, args) {
	if (positional.kind === "array") {
		const name = positional.parameter.placeholder ?? "args";
		return formatRowsWithColumns([[args.ansiColor ? `\x1B[1m${name}...\x1B[22m` : `${name}...`, args.ansiColor ? `\x1B[3m${positional.parameter.brief}\x1B[23m` : positional.parameter.brief]], ["  "]);
	}
	const { keywords } = args.text;
	const atLeastOneOptional = positional.parameters.some((def) => def.optional);
	return formatRowsWithColumns(positional.parameters.map((def, i) => {
		let name = def.placeholder ?? `arg${i + 1}`;
		let suffix;
		if (def.optional) name = `[${name}]`;
		else if (atLeastOneOptional) name = ` ${name}`;
		if (def.default) suffix = `[${args.ansiColor ? `\x1B[2m${keywords.default}\x1B[22m` : keywords.default} ${def.default}]`;
		return [
			args.ansiColor ? `\x1B[1m${name}\x1B[22m` : name,
			args.ansiColor ? `\x1B[3m${def.brief}\x1B[23m` : def.brief,
			suffix ?? ""
		];
	}), ["  ", " "]);
}
function* generateCommandHelpLines(parameters, docs, args) {
	const { brief, fullDescription, customUsage } = docs;
	const { headers } = args.text;
	const prefix = args.prefix.join(" ");
	yield args.ansiColor ? `\x1B[4m${headers.usage}\x1B[24m` : headers.usage;
	if (customUsage) for (const usage of customUsage) if (typeof usage === "string") yield `  ${prefix} ${usage}`;
	else {
		const brief2 = args.ansiColor ? `\x1B[3m${usage.brief}\x1B[23m` : usage.brief;
		yield `  ${prefix} ${usage.input}
    ${brief2}`;
	}
	else yield `  ${formatUsageLineForParameters(parameters, args)}`;
	for (const line of generateUsageLinesForAdditionalFlags(args.additionalFlags, args.includeHidden, args.config.caseStyle, args.config.useAliasInUsageLine)) yield `  ${prefix} ${line}`;
	yield "";
	yield fullDescription ?? brief;
	if (args.aliases && args.aliases.length > 0) {
		const aliasPrefix = args.prefix.slice(0, -1).join(" ");
		yield "";
		yield args.ansiColor ? `\x1B[4m${headers.aliases}\x1B[24m` : headers.aliases;
		for (const alias of args.aliases) yield `  ${aliasPrefix} ${alias}`;
	}
	yield "";
	yield args.ansiColor ? `\x1B[4m${headers.flags}\x1B[24m` : headers.flags;
	for (const line of formatDocumentationForFlagParameters(parameters.flags ?? {}, parameters.aliases ?? {}, args)) yield `  ${line}`;
	const positional = parameters.positional ?? {
		kind: "tuple",
		parameters: []
	};
	if (positional.kind === "array" || positional.parameters.length > 0) {
		yield "";
		yield args.ansiColor ? `\x1B[4m${headers.arguments}\x1B[24m` : headers.arguments;
		for (const line of formatDocumentationForPositionalParameters(positional, args)) yield `  ${line}`;
	}
}
function* asNegationFlagNames(flagName) {
	yield `no-${convertCamelCaseToKebabCase(flagName)}`;
	yield `no${flagName[0].toUpperCase()}${flagName.slice(1)}`;
}
function checkForNegationCollisions(flags) {
	const flagsAllowingNegation = Object.entries(flags).filter(([, flag]) => flag.kind === "boolean" && !flag.optional);
	for (const [internalFlagName] of flagsAllowingNegation) for (const negatedFlagName of asNegationFlagNames(internalFlagName)) if (negatedFlagName in flags) throw new InternalError(`Unable to allow negation for --${internalFlagName} as it conflicts with --${negatedFlagName}`);
}
function checkForInvalidVariadicSeparators(flags) {
	for (const [internalFlagName, flag] of Object.entries(flags)) if ("variadic" in flag && typeof flag.variadic === "string") {
		if (flag.variadic.length < 1) throw new InternalError(`Unable to use "" as variadic separator for --${internalFlagName} as it is empty`);
		if (/\s/.test(flag.variadic)) throw new InternalError(`Unable to use "${flag.variadic}" as variadic separator for --${internalFlagName} as it contains whitespace`);
	}
}
function buildCommand(builderArgs) {
	const { flags = {}, aliases = {} } = builderArgs.parameters;
	checkForNegationCollisions(flags);
	checkForInvalidVariadicSeparators(flags);
	let loader;
	if ("func" in builderArgs) loader = async () => builderArgs.func;
	else loader = builderArgs.loader;
	return {
		kind: CommandSymbol,
		loader,
		parameters: builderArgs.parameters,
		get brief() {
			return builderArgs.docs.brief;
		},
		/* v8 ignore next -- @preserve */
		get fullDescription() {
			return builderArgs.docs.fullDescription;
		},
		formatUsageLine: (args) => {
			return formatUsageLineForParameters(builderArgs.parameters, args);
		},
		formatHelp: (args) => {
			return [...generateCommandHelpLines(builderArgs.parameters, builderArgs.docs, args)].join("\n") + "\n";
		},
		usesFlag: (flagName, caseStyle) => {
			if (caseStyle === "allow-kebab-for-camel") {
				if (convertCamelCaseToKebabCase(flagName) in flags) return true;
			}
			return Boolean(flagName in flags || flagName in aliases);
		}
	};
}
function* generateRouteMapHelpLines(routes, docs, args) {
	const { brief, fullDescription, hideRoute } = docs;
	const { headers } = args.text;
	yield args.ansiColor ? `\x1B[4m${headers.usage}\x1B[24m` : headers.usage;
	for (const [name, route] of Object.entries(routes)) if (!hideRoute || !hideRoute[name] || args.includeHidden) {
		const externalRouteName = args.config.caseStyle === "convert-camel-to-kebab" ? convertCamelCaseToKebabCase(name) : name;
		yield `  ${route.formatUsageLine({
			...args,
			prefix: [...args.prefix, externalRouteName]
		})}`;
	}
	const prefix = args.prefix.join(" ");
	for (const line of generateUsageLinesForAdditionalFlags(args.additionalFlags, args.includeHidden, args.config.caseStyle, args.config.useAliasInUsageLine)) yield `  ${prefix} ${line}`;
	yield "";
	yield fullDescription ?? brief;
	if (args.aliases && args.aliases.length > 0) {
		const aliasPrefix = args.prefix.slice(0, -1).join(" ");
		yield "";
		yield args.ansiColor ? `\x1B[4m${headers.aliases}\x1B[24m` : headers.aliases;
		for (const alias of args.aliases) yield `  ${aliasPrefix} ${alias}`;
	}
	yield "";
	yield args.ansiColor ? `\x1B[4m${headers.flags}\x1B[24m` : headers.flags;
	for (const line of formatDocumentationForFlagParameters({}, {}, args)) yield `  ${line}`;
	yield "";
	yield args.ansiColor ? `\x1B[4m${headers.commands}\x1B[24m` : headers.commands;
	const formattedRows = formatRowsWithColumns(Object.entries(routes).filter(([name]) => !hideRoute || !hideRoute[name] || args.includeHidden).map(([internalRouteName, route]) => {
		return {
			routeName: formatForDisplay(internalRouteName, args.config.caseStyle),
			brief: route.brief,
			hidden: hideRoute && hideRoute[internalRouteName]
		};
	}).map((row) => {
		if (!args.ansiColor) return [row.routeName, row.brief];
		return [row.hidden ? `\x1B[2m${row.routeName}\x1B[22m` : `\x1B[1m${row.routeName}\x1B[22m`, row.hidden ? `\x1B[2;3m${row.brief}\x1B[22;23m` : `\x1B[;;3m${row.brief}\x1B[;;;23m`];
	}), ["  "]);
	for (const line of formattedRows) yield `  ${line}`;
}
function buildRouteMap({ routes, defaultCommand: defaultCommandRoute, docs, aliases }) {
	if (Object.entries(routes).length === 0) throw new InternalError("Route map must contain at least one route");
	const activeAliases = aliases ?? {};
	const aliasesByRoute = /* @__PURE__ */ new Map();
	for (const [alias, routeName] of Object.entries(activeAliases)) {
		if (alias in routes) throw new InternalError(`Cannot use '${alias}' as an alias when a route with that name already exists`);
		const routeAliases = aliasesByRoute.get(routeName) ?? [];
		aliasesByRoute.set(routeName, [...routeAliases, alias]);
	}
	const defaultCommand = defaultCommandRoute ? routes[defaultCommandRoute] : void 0;
	if (defaultCommand && defaultCommand.kind === RouteMapSymbol) throw new InternalError(`Cannot use '${defaultCommandRoute}' as the default command because it is not a Command`);
	const resolveRouteName = (input) => {
		if (input in activeAliases) return activeAliases[input];
		else if (input in routes) return input;
	};
	return {
		kind: RouteMapSymbol,
		get brief() {
			return docs.brief;
		},
		/* v8 ignore next -- @preserve */
		get fullDescription() {
			return docs.fullDescription;
		},
		formatUsageLine(args) {
			const routeNames = this.getAllEntries().filter((entry) => !entry.hidden).map((entry) => entry.name[args.config.caseStyle]);
			return `${args.prefix.join(" ")} ${routeNames.join("|")} ...`;
		},
		formatHelp: (args) => {
			return [...generateRouteMapHelpLines(routes, docs, args)].join("\n") + "\n";
		},
		getDefaultCommand: () => {
			return defaultCommand;
		},
		getOtherAliasesForInput: (input, caseStyle) => {
			if (defaultCommandRoute) {
				if (input === defaultCommandRoute) return {
					original: [""],
					"convert-camel-to-kebab": [""]
				};
				if (input === "") return {
					original: [defaultCommandRoute],
					"convert-camel-to-kebab": [defaultCommandRoute]
				};
			}
			const camelInput = convertKebabCaseToCamelCase(input);
			let routeName = resolveRouteName(input);
			if (!routeName && caseStyle === "allow-kebab-for-camel") routeName = resolveRouteName(camelInput);
			if (!routeName) return {
				original: [],
				"convert-camel-to-kebab": []
			};
			const otherAliases = [routeName, ...aliasesByRoute.get(routeName) ?? []].filter((alias) => alias !== input && alias !== camelInput);
			return {
				original: otherAliases,
				"convert-camel-to-kebab": otherAliases.map(convertCamelCaseToKebabCase)
			};
		},
		getRoutingTargetForInput: (input) => {
			return routes[input in activeAliases ? activeAliases[input] : input];
		},
		getAllEntries() {
			const hiddenRoutes = docs.hideRoute;
			return Object.entries(routes).map(([originalRouteName, target]) => {
				return {
					name: {
						original: originalRouteName,
						"convert-camel-to-kebab": convertCamelCaseToKebabCase(originalRouteName)
					},
					target,
					aliases: aliasesByRoute.get(originalRouteName) ?? [],
					hidden: hiddenRoutes?.[originalRouteName] ?? false
				};
			});
		}
	};
}
async function run$2(app, inputs, context) {
	const exitCode = await runApplication(app, inputs, context);
	context.process.exitCode ??= exitCode;
}
/* v8 ignore next -- @preserve */
/* v8 ignore if -- @preserve */
/* v8 ignore else -- @preserve */
//#endregion
//#region package.json
var version = "0.1.0";
const SECRET_RULES = [
	{
		id: "aws-access-key",
		label: "AWS access key",
		pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/
	},
	{
		id: "aws-secret-key",
		label: "AWS secret access key",
		pattern: /\baws[_-]secret[_-]access[_-]key["']?[ \t]*[=:][ \t]*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i
	},
	{
		id: "github-token",
		label: "GitHub token",
		pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{82}\b/
	},
	{
		id: "gitlab-token",
		label: "GitLab token",
		pattern: /\bglpat-[0-9A-Za-z_-]{20}\b/
	},
	{
		id: "slack-token",
		label: "Slack token",
		pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b|https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z_]{8,12}\/B[0-9A-Za-z_]{8,12}\/[0-9A-Za-z_]{24}/
	},
	{
		id: "stripe-key",
		label: "Stripe live key",
		pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,99}\b/
	},
	{
		id: "google-api-key",
		label: "Google API key",
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/
	},
	{
		id: "openai-key",
		label: "OpenAI key",
		pattern: /(?<=(\bsk-(?:proj-|svcacct-|admin-)?[0-9A-Za-z_-]{20,128}))T3BlbkFJ[0-9A-Za-z_-]{20,128}\b/,
		capturedPrefix: true
	},
	{
		id: "anthropic-key",
		label: "Anthropic key",
		pattern: /\bsk-ant-(?:api|admin)\d{2}-[0-9A-Za-z_-]{80,256}\b/
	},
	{
		id: "npm-token",
		label: "npm token",
		pattern: /\bnpm_[0-9A-Za-z]{36}\b/
	},
	{
		id: "sendgrid-key",
		label: "SendGrid key",
		pattern: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/
	},
	{
		id: "braid-token",
		label: "Braid token",
		pattern: /\bbraid_(?:agent|at)_[0-9A-Za-z_.-]{20,4096}/
	},
	{
		id: "private-key",
		label: "private key",
		pattern: /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/
	}
];
/** Matches include any captured prefix so detection and metadata redaction cover the same whole credential. */
function* matches$1(text, rule) {
	for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "") + "g"))) {
		const prefix = rule.capturedPrefix ? match[1] : "";
		yield {
			value: prefix + match[0],
			index: match.index - prefix.length
		};
	}
}
function redactSecret(text, rule) {
	const parts = [];
	let end = 0;
	for (const match of matches$1(text, rule)) {
		if (match.index < end) continue;
		parts.push(text.slice(end, match.index), "[redacted]");
		end = match.index + match.value.length;
	}
	return parts.length ? parts.join("") + text.slice(end) : text;
}
//#endregion
//#region ../shared/privacy.ts
/** Includes internationalized local parts and domain names. Account ids can contain these too. */
const EMAIL_PATTERN = /(?<![\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}.-]*[\p{L}\p{N}\p{M}])?\.[\p{L}\p{M}]{2,}/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----|$)/g;
const CREDENTIAL_URL = /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s<>"']+/gi;
const BRAID_CREDENTIAL = /\bbraid_(?:agent|at)_[A-Za-z0-9_.-]+\b/g;
const redactEmails = (text) => text.replace(EMAIL_PATTERN, "[private email]");
function redactPublicText(text) {
	return SECRET_RULES.reduce(redactSecret, redactEmails(text.replace(PRIVATE_KEY_BLOCK, "[redacted]")).replace(CREDENTIAL_URL, "[redacted]").replace(BRAID_CREDENTIAL, "[redacted]"));
}
//#endregion
//#region src/context.ts
/** A failure the person or agent running braid can act on. Its message is printed as it is, without a stack. */
var CliError = class extends Error {};
function fail(message) {
	throw new CliError(message);
}
const print = (context, text = "") => context.process.stdout.write(`${redactEmails(text)}\n`);
const note = (context, text) => context.process.stderr.write(`${redactEmails(text)}\n`);
const DEFAULT_CONFIG = {
	lang: void 0,
	message: void 0,
	abortEarly: void 0,
	abortPipeEarly: void 0
};
/**
* Returns the global configuration.
*
* @param config The config to merge.
*
* @returns The configuration.
*/
/* @__NO_SIDE_EFFECTS__ */
function getGlobalConfig(config$1) {
	if (!config$1 && true) return DEFAULT_CONFIG;
	return {
		lang: config$1?.lang ?? void 0,
		message: config$1?.message,
		abortEarly: config$1?.abortEarly ?? void 0,
		abortPipeEarly: config$1?.abortPipeEarly ?? void 0
	};
}
/**
* Stringifies an unknown input to a literal or type string.
*
* @param input The unknown input.
*
* @returns A literal or type string.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _stringify(input) {
	const type = typeof input;
	if (type === "string") return `"${input}"`;
	if (type === "number" || type === "bigint" || type === "boolean") return `${input}`;
	if (type === "object" || type === "function") return (input && Object.getPrototypeOf(input)?.constructor?.name) ?? "null";
	return type;
}
/**
* Adds an issue to the dataset.
*
* @param context The issue context.
* @param label The issue label.
* @param dataset The input dataset.
* @param config The configuration.
* @param other The optional props.
*
* @internal
*/
function _addIssue(context, label, dataset, config$1, other) {
	const input = other && "input" in other ? other.input : dataset.value;
	const expected = other?.expected ?? context.expects ?? null;
	const received = other?.received ?? /* @__PURE__ */ _stringify(input);
	const issue = {
		kind: context.kind,
		type: context.type,
		input,
		expected,
		received,
		message: `Invalid ${label}: ${expected ? `Expected ${expected} but r` : "R"}eceived ${received}`,
		requirement: context.requirement,
		path: other?.path,
		issues: other?.issues,
		lang: config$1.lang,
		abortEarly: config$1.abortEarly,
		abortPipeEarly: config$1.abortPipeEarly
	};
	const isSchema = context.kind === "schema";
	const message$1 = other?.message ?? context.message ?? (context.reference, issue.lang, void 0) ?? (isSchema ? (issue.lang, void 0) : null) ?? config$1.message ?? (issue.lang, void 0);
	if (message$1 !== void 0) issue.message = typeof message$1 === "function" ? message$1(issue) : message$1;
	if (isSchema) dataset.typed = false;
	if (dataset.issues) dataset.issues.push(issue);
	else dataset.issues = [issue];
}
/**
* Compares two values using the SameValueZero algorithm, which treats `NaN`
* as equal to itself unlike `===`.
*
* @param value1 The first value.
* @param value2 The second value.
*
* @returns Whether the values are equal.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _isSameValueZero(value1, value2) {
	return value1 === value2 || Number.isNaN(value1) && Number.isNaN(value2);
}
/**
* Disallows inherited object properties and prevents object prototype
* pollution by disallowing certain keys.
*
* @param object The object to check.
* @param key The key to check.
*
* @returns Whether the key is allowed.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _isValidObjectKey(object$1, key) {
	return Object.prototype.hasOwnProperty.call(object$1, key) && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}
/**
* Joins multiple `expects` values with the given separator.
*
* @param values The `expects` values.
* @param separator The separator.
*
* @returns The joined `expects` property.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _joinExpects(values$1, separator) {
	const list = [...new Set(values$1)];
	if (list.length > 1) return `(${list.join(` ${separator} `)})`;
	return list[0] ?? "never";
}
/**
* Eagerly creates and attaches the Standard Schema properties of a schema.
*
* Hint: The contextual `this` type includes the standard properties that are
* attached before the schema is returned.
*
* @param schema The schema to attach standard properties to.
*
* @returns The schema with standard properties attached.
*
* @internal
*/
function _standardSchema(schema) {
	schema["~standard"] = {
		version: 1,
		vendor: "valibot",
		validate: (value$1) => schema["~run"]({ value: value$1 }, /* @__PURE__ */ getGlobalConfig())
	};
	return schema;
}
/**
* [UUID](https://en.wikipedia.org/wiki/Universally_unique_identifier) regex.
*/
const UUID_REGEX = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
/* @__NO_SIDE_EFFECTS__ */
function check(requirement, message$1) {
	return {
		kind: "validation",
		type: "check",
		reference: check,
		async: false,
		expects: null,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "input", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function gtValue(requirement, message$1) {
	return {
		kind: "validation",
		type: "gt_value",
		reference: gtValue,
		async: false,
		expects: `>${requirement instanceof Date ? requirement.toJSON() : /* @__PURE__ */ _stringify(requirement)}`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !(dataset.value > this.requirement)) _addIssue(this, "value", dataset, config$1, { received: dataset.value instanceof Date ? dataset.value.toJSON() : /* @__PURE__ */ _stringify(dataset.value) });
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function integer(message$1) {
	return {
		kind: "validation",
		type: "integer",
		reference: integer,
		async: false,
		expects: null,
		requirement: Number.isInteger,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "integer", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function maxLength(requirement, message$1) {
	return {
		kind: "validation",
		type: "max_length",
		reference: maxLength,
		async: false,
		expects: `<=${requirement}`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && dataset.value.length > this.requirement) _addIssue(this, "length", dataset, config$1, { received: `${dataset.value.length}` });
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function maxValue(requirement, message$1) {
	return {
		kind: "validation",
		type: "max_value",
		reference: maxValue,
		async: false,
		expects: `<=${requirement instanceof Date ? requirement.toJSON() : /* @__PURE__ */ _stringify(requirement)}`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !(dataset.value <= this.requirement)) _addIssue(this, "value", dataset, config$1, { received: dataset.value instanceof Date ? dataset.value.toJSON() : /* @__PURE__ */ _stringify(dataset.value) });
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function minLength(requirement, message$1) {
	return {
		kind: "validation",
		type: "min_length",
		reference: minLength,
		async: false,
		expects: `>=${requirement}`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && dataset.value.length < this.requirement) _addIssue(this, "length", dataset, config$1, { received: `${dataset.value.length}` });
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function minValue(requirement, message$1) {
	return {
		kind: "validation",
		type: "min_value",
		reference: minValue,
		async: false,
		expects: `>=${requirement instanceof Date ? requirement.toJSON() : /* @__PURE__ */ _stringify(requirement)}`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !(dataset.value >= this.requirement)) _addIssue(this, "value", dataset, config$1, { received: dataset.value instanceof Date ? dataset.value.toJSON() : /* @__PURE__ */ _stringify(dataset.value) });
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function nonEmpty(message$1) {
	return {
		kind: "validation",
		type: "non_empty",
		reference: nonEmpty,
		async: false,
		expects: "!0",
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && dataset.value.length === 0) _addIssue(this, "length", dataset, config$1, { received: "0" });
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function parseJson(config$1, message$1) {
	return {
		kind: "transformation",
		type: "parse_json",
		reference: parseJson,
		config: config$1,
		message: message$1,
		async: false,
		"~run"(dataset, config$2) {
			try {
				dataset.value = JSON.parse(dataset.value, this.config?.reviver);
			} catch (error) {
				if (error instanceof Error) {
					_addIssue(this, "JSON", dataset, config$2, { received: `"${error.message}"` });
					dataset.typed = false;
				} else throw error;
			}
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function regex(requirement, message$1) {
	return {
		kind: "validation",
		type: "regex",
		reference: regex,
		async: false,
		expects: `${requirement}`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !this.requirement.test(dataset.value)) _addIssue(this, "format", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function safeInteger(message$1) {
	return {
		kind: "validation",
		type: "safe_integer",
		reference: safeInteger,
		async: false,
		expects: null,
		requirement: Number.isSafeInteger,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "safe integer", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function startsWith(requirement, message$1) {
	return {
		kind: "validation",
		type: "starts_with",
		reference: startsWith,
		async: false,
		expects: `"${requirement}"`,
		requirement,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !dataset.value.startsWith(this.requirement)) _addIssue(this, "start", dataset, config$1, { received: `"${dataset.value.slice(0, this.requirement.length)}"` });
			return dataset;
		}
	};
}
/**
* Creates a custom transformation action.
*
* @param operation The transformation operation.
*
* @returns A transform action.
*/
/* @__NO_SIDE_EFFECTS__ */
function transform(operation) {
	return {
		kind: "transformation",
		type: "transform",
		reference: transform,
		async: false,
		operation,
		"~run"(dataset) {
			dataset.value = this.operation(dataset.value);
			return dataset;
		}
	};
}
/**
* Creates a trim transformation action.
*
* @returns A trim action.
*/
/* @__NO_SIDE_EFFECTS__ */
function trim() {
	return {
		kind: "transformation",
		type: "trim",
		reference: trim,
		async: false,
		"~run"(dataset) {
			dataset.value = dataset.value.trim();
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function url$1(message$1) {
	return {
		kind: "validation",
		type: "url",
		reference: url$1,
		async: false,
		expects: null,
		requirement(input) {
			try {
				if (URL.canParse) return URL.canParse(input);
				new URL(input);
				return true;
			} catch {
				return false;
			}
		},
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "URL", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function uuid(message$1) {
	return {
		kind: "validation",
		type: "uuid",
		reference: uuid,
		async: false,
		expects: null,
		requirement: UUID_REGEX,
		message: message$1,
		"~run"(dataset, config$1) {
			if (dataset.typed && !this.requirement.test(dataset.value)) _addIssue(this, "UUID", dataset, config$1);
			return dataset;
		}
	};
}
const ABORT_EARLY_CONFIG = { abortEarly: true };
/**
* Returns the fallback value of the schema.
*
* @param schema The schema to get it from.
* @param dataset The output dataset if available.
* @param config The config if available.
*
* @returns The fallback value.
*/
/* @__NO_SIDE_EFFECTS__ */
function getFallback(schema, dataset, config$1) {
	return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
}
/**
* Returns the default value of the schema.
*
* @param schema The schema to get it from.
* @param dataset The input dataset if available.
* @param config The config if available.
*
* @returns The default value.
*/
/* @__NO_SIDE_EFFECTS__ */
function getDefault(schema, dataset, config$1) {
	return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
}
/**
* Checks if the input matches the schema. By using a type predicate, this
* function can be used as a type guard.
*
* @param schema The schema to be used.
* @param input The input to be tested.
*
* @returns Whether the input matches the schema.
*/
/* @__NO_SIDE_EFFECTS__ */
function is(schema, input) {
	return !schema["~run"]({ value: input }, ABORT_EARLY_CONFIG).issues;
}
/* @__NO_SIDE_EFFECTS__ */
function array(item, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "array",
		reference: array,
		expects: "Array",
		async: false,
		item,
		message: message$1,
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (Array.isArray(input)) {
				dataset.typed = true;
				dataset.value = [];
				for (let key = 0; key < input.length; key++) {
					const value$1 = input[key];
					const itemDataset = this.item["~run"]({ value: value$1 }, config$1);
					if (itemDataset.issues) {
						const pathItem = {
							type: "array",
							origin: "value",
							input,
							key,
							value: value$1
						};
						for (const issue of itemDataset.issues) {
							if (issue.path) issue.path.unshift(pathItem);
							else issue.path = [pathItem];
							dataset.issues?.push(issue);
						}
						if (!dataset.issues) dataset.issues = itemDataset.issues;
						if (config$1.abortEarly) {
							dataset.typed = false;
							break;
						}
					}
					if (!itemDataset.typed) dataset.typed = false;
					dataset.value.push(itemDataset.value);
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function boolean(message$1) {
	return _standardSchema({
		kind: "schema",
		type: "boolean",
		reference: boolean,
		expects: "boolean",
		async: false,
		message: message$1,
		"~run"(dataset, config$1) {
			if (typeof dataset.value === "boolean") dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function literal(literal_, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "literal",
		reference: literal,
		expects: /* @__PURE__ */ _stringify(literal_),
		async: false,
		literal: literal_,
		message: message$1,
		"~run"(dataset, config$1) {
			if (/* @__PURE__ */ _isSameValueZero(dataset.value, this.literal)) dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function looseObject(entries$1, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "loose_object",
		reference: looseObject,
		expects: "Object",
		async: false,
		entries: entries$1,
		message: message$1,
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (input && typeof input === "object") {
				dataset.typed = true;
				dataset.value = {};
				for (const key in this.entries) {
					const valueSchema = this.entries[key];
					if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
						const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
						const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
						if (valueDataset.issues) {
							const pathItem = {
								type: "object",
								origin: "value",
								input,
								key,
								value: value$1
							};
							for (const issue of valueDataset.issues) {
								if (issue.path) issue.path.unshift(pathItem);
								else issue.path = [pathItem];
								dataset.issues?.push(issue);
							}
							if (!dataset.issues) dataset.issues = valueDataset.issues;
							if (config$1.abortEarly) {
								dataset.typed = false;
								break;
							}
						}
						if (!valueDataset.typed) dataset.typed = false;
						dataset.value[key] = valueDataset.value;
					} else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
					else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
						_addIssue(this, "key", dataset, config$1, {
							input: void 0,
							expected: `"${key}"`,
							path: [{
								type: "object",
								origin: "key",
								input,
								key,
								value: input[key]
							}]
						});
						if (config$1.abortEarly) break;
					}
				}
				if (!dataset.issues || !config$1.abortEarly) {
					for (const key in input) if (/* @__PURE__ */ _isValidObjectKey(input, key) && !Object.prototype.hasOwnProperty.call(this.entries, key)) dataset.value[key] = input[key];
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function nullable(wrapped, default_) {
	return _standardSchema({
		kind: "schema",
		type: "nullable",
		reference: nullable,
		expects: `(${wrapped.expects} | null)`,
		async: false,
		wrapped,
		default: default_,
		"~run"(dataset, config$1) {
			if (dataset.value === null) {
				if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
				if (dataset.value === null) {
					dataset.typed = true;
					return dataset;
				}
			}
			return this.wrapped["~run"](dataset, config$1);
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function number(message$1) {
	return _standardSchema({
		kind: "schema",
		type: "number",
		reference: number,
		expects: "number",
		async: false,
		message: message$1,
		"~run"(dataset, config$1) {
			if (typeof dataset.value === "number" && !isNaN(dataset.value)) dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function object(entries$1, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "object",
		reference: object,
		expects: "Object",
		async: false,
		entries: entries$1,
		message: message$1,
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (input && typeof input === "object") {
				dataset.typed = true;
				dataset.value = {};
				for (const key in this.entries) {
					const valueSchema = this.entries[key];
					if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
						const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
						const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
						if (valueDataset.issues) {
							const pathItem = {
								type: "object",
								origin: "value",
								input,
								key,
								value: value$1
							};
							for (const issue of valueDataset.issues) {
								if (issue.path) issue.path.unshift(pathItem);
								else issue.path = [pathItem];
								dataset.issues?.push(issue);
							}
							if (!dataset.issues) dataset.issues = valueDataset.issues;
							if (config$1.abortEarly) {
								dataset.typed = false;
								break;
							}
						}
						if (!valueDataset.typed) dataset.typed = false;
						dataset.value[key] = valueDataset.value;
					} else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
					else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
						_addIssue(this, "key", dataset, config$1, {
							input: void 0,
							expected: `"${key}"`,
							path: [{
								type: "object",
								origin: "key",
								input,
								key,
								value: input[key]
							}]
						});
						if (config$1.abortEarly) break;
					}
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function optional$1(wrapped, default_) {
	return _standardSchema({
		kind: "schema",
		type: "optional",
		reference: optional$1,
		expects: `(${wrapped.expects} | undefined)`,
		async: false,
		wrapped,
		default: default_,
		"~run"(dataset, config$1) {
			if (dataset.value === void 0) {
				if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
				if (dataset.value === void 0) {
					dataset.typed = true;
					return dataset;
				}
			}
			return this.wrapped["~run"](dataset, config$1);
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function picklist(options, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "picklist",
		reference: picklist,
		expects: /* @__PURE__ */ _joinExpects(options.map(_stringify), "|"),
		async: false,
		options,
		message: message$1,
		"~run"(dataset, config$1) {
			if (this.options.includes(dataset.value)) dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function record(key, value$1, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "record",
		reference: record,
		expects: "Object",
		async: false,
		key,
		value: value$1,
		message: message$1,
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (input && typeof input === "object") {
				dataset.typed = true;
				dataset.value = {};
				for (const entryKey in input) if (/* @__PURE__ */ _isValidObjectKey(input, entryKey)) {
					const entryValue = input[entryKey];
					const keyDataset = this.key["~run"]({ value: entryKey }, config$1);
					if (keyDataset.issues) {
						const pathItem = {
							type: "object",
							origin: "key",
							input,
							key: entryKey,
							value: entryValue
						};
						for (const issue of keyDataset.issues) {
							issue.path = [pathItem];
							dataset.issues?.push(issue);
						}
						if (!dataset.issues) dataset.issues = keyDataset.issues;
						if (config$1.abortEarly) {
							dataset.typed = false;
							break;
						}
					}
					const valueDataset = this.value["~run"]({ value: entryValue }, config$1);
					if (valueDataset.issues) {
						const pathItem = {
							type: "object",
							origin: "value",
							input,
							key: entryKey,
							value: entryValue
						};
						for (const issue of valueDataset.issues) {
							if (issue.path) issue.path.unshift(pathItem);
							else issue.path = [pathItem];
							dataset.issues?.push(issue);
						}
						if (!dataset.issues) dataset.issues = valueDataset.issues;
						if (config$1.abortEarly) {
							dataset.typed = false;
							break;
						}
					}
					if (!keyDataset.typed || !valueDataset.typed) dataset.typed = false;
					if (keyDataset.typed) dataset.value[keyDataset.value] = valueDataset.value;
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function strictObject(entries$1, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "strict_object",
		reference: strictObject,
		expects: "Object",
		async: false,
		entries: entries$1,
		message: message$1,
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (input && typeof input === "object") {
				dataset.typed = true;
				dataset.value = {};
				for (const key in this.entries) {
					const valueSchema = this.entries[key];
					if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
						const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
						const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
						if (valueDataset.issues) {
							const pathItem = {
								type: "object",
								origin: "value",
								input,
								key,
								value: value$1
							};
							for (const issue of valueDataset.issues) {
								if (issue.path) issue.path.unshift(pathItem);
								else issue.path = [pathItem];
								dataset.issues?.push(issue);
							}
							if (!dataset.issues) dataset.issues = valueDataset.issues;
							if (config$1.abortEarly) {
								dataset.typed = false;
								break;
							}
						}
						if (!valueDataset.typed) dataset.typed = false;
						dataset.value[key] = valueDataset.value;
					} else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
					else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
						_addIssue(this, "key", dataset, config$1, {
							input: void 0,
							expected: `"${key}"`,
							path: [{
								type: "object",
								origin: "key",
								input,
								key,
								value: input[key]
							}]
						});
						if (config$1.abortEarly) break;
					}
				}
				if (!dataset.issues || !config$1.abortEarly) {
					for (const key in input) if (!Object.prototype.hasOwnProperty.call(this.entries, key)) {
						_addIssue(this, "key", dataset, config$1, {
							input: key,
							expected: "never",
							path: [{
								type: "object",
								origin: "key",
								input,
								key,
								value: input[key]
							}]
						});
						break;
					}
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function string(message$1) {
	return _standardSchema({
		kind: "schema",
		type: "string",
		reference: string,
		expects: "string",
		async: false,
		message: message$1,
		"~run"(dataset, config$1) {
			if (typeof dataset.value === "string") dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/**
* Returns the sub issues of the provided datasets for the union issue.
*
* @param datasets The datasets.
*
* @returns The sub issues.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _subIssues(datasets) {
	let issues;
	if (datasets) for (const dataset of datasets) if (issues) for (const issue of dataset.issues) issues.push(issue);
	else issues = dataset.issues;
	return issues;
}
/* @__NO_SIDE_EFFECTS__ */
function union(options, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "union",
		reference: union,
		expects: /* @__PURE__ */ _joinExpects(options.map((option) => option.expects), "|"),
		async: false,
		options,
		message: message$1,
		"~run"(dataset, config$1) {
			let validDataset;
			let typedDatasets;
			let untypedDatasets;
			for (const schema of this.options) {
				const optionDataset = schema["~run"]({ value: dataset.value }, config$1);
				if (optionDataset.typed) if (optionDataset.issues) if (typedDatasets) typedDatasets.push(optionDataset);
				else typedDatasets = [optionDataset];
				else {
					validDataset = optionDataset;
					break;
				}
				else if (untypedDatasets) untypedDatasets.push(optionDataset);
				else untypedDatasets = [optionDataset];
			}
			if (validDataset) return validDataset;
			if (typedDatasets) {
				if (typedDatasets.length === 1) return typedDatasets[0];
				_addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(typedDatasets) });
				dataset.typed = true;
			} else if (untypedDatasets?.length === 1) return untypedDatasets[0];
			else _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(untypedDatasets) });
			return dataset;
		}
	});
}
/**
* Creates a unknown schema.
*
* @returns A unknown schema.
*/
/* @__NO_SIDE_EFFECTS__ */
function unknown() {
	return _standardSchema({
		kind: "schema",
		type: "unknown",
		reference: unknown,
		expects: "unknown",
		async: false,
		"~run"(dataset) {
			dataset.typed = true;
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function variant(key, options, message$1) {
	return _standardSchema({
		kind: "schema",
		type: "variant",
		reference: variant,
		expects: "Object",
		async: false,
		key,
		options,
		message: message$1,
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (input && typeof input === "object") {
				let outputDataset;
				let maxDiscriminatorPriority = 0;
				let invalidDiscriminatorKey = this.key;
				let expectedDiscriminators = [];
				const parseOptions = (variant$1, allKeys) => {
					for (const schema of variant$1.options) {
						if (schema.type === "variant") parseOptions(schema, new Set(allKeys).add(schema.key));
						else {
							let keysAreValid = true;
							let currentPriority = 0;
							for (const currentKey of allKeys) {
								const discriminatorSchema = schema.entries[currentKey];
								if (currentKey in input ? discriminatorSchema["~run"]({
									typed: false,
									value: input[currentKey]
								}, ABORT_EARLY_CONFIG).issues : discriminatorSchema.type !== "exact_optional" && discriminatorSchema.type !== "optional" && discriminatorSchema.type !== "nullish") {
									keysAreValid = false;
									if (invalidDiscriminatorKey !== currentKey && (maxDiscriminatorPriority < currentPriority || maxDiscriminatorPriority === currentPriority && currentKey in input && !(invalidDiscriminatorKey in input))) {
										maxDiscriminatorPriority = currentPriority;
										invalidDiscriminatorKey = currentKey;
										expectedDiscriminators = [];
									}
									if (invalidDiscriminatorKey === currentKey) expectedDiscriminators.push(schema.entries[currentKey].expects);
									break;
								}
								currentPriority++;
							}
							if (keysAreValid) {
								const optionDataset = schema["~run"]({ value: input }, config$1);
								if (!outputDataset || !outputDataset.typed && optionDataset.typed) outputDataset = optionDataset;
							}
						}
						if (outputDataset && !outputDataset.issues) break;
					}
				};
				parseOptions(this, /* @__PURE__ */ new Set([this.key]));
				if (outputDataset) return outputDataset;
				_addIssue(this, "type", dataset, config$1, {
					input: input[invalidDiscriminatorKey],
					expected: /* @__PURE__ */ _joinExpects(expectedDiscriminators, "|"),
					path: [{
						type: "object",
						origin: "value",
						input,
						key: invalidDiscriminatorKey,
						value: input[invalidDiscriminatorKey]
					}]
				});
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	});
}
/* @__NO_SIDE_EFFECTS__ */
function pipe(...pipe$1) {
	return _standardSchema({
		...pipe$1[0],
		pipe: pipe$1,
		"~run"(dataset, config$1) {
			for (const item of pipe$1) if (item.kind !== "metadata") {
				if (dataset.issues && (item.kind === "schema" || item.kind === "transformation")) {
					dataset.typed = false;
					break;
				}
				if (!dataset.issues || !config$1.abortEarly && !config$1.abortPipeEarly) dataset = item["~run"](dataset, config$1);
			}
			return dataset;
		}
	});
}
/**
* Parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param input The input to be parsed.
* @param config The parse configuration.
*
* @returns The parse result.
*/
/* @__NO_SIDE_EFFECTS__ */
function safeParse(schema, input, config$1) {
	const dataset = schema["~run"]({ value: input }, /* @__PURE__ */ getGlobalConfig(config$1));
	return {
		typed: dataset.typed,
		success: !dataset.issues,
		output: dataset.value,
		issues: dataset.issues
	};
}
//#endregion
//#region ../shared/models.ts
const ACRONYMS = {
	gpt: "GPT",
	glm: "GLM",
	cli: "CLI",
	ai: "AI",
	api: "API",
	llm: "LLM",
	bge: "BGE",
	fp8: "FP8",
	awq: "AWQ",
	ide: "IDE"
};
/** A model id or tool name as people read it: `claude-opus-5-5` is Claude Opus 5.5, `@cf/zai-org/glm-5.3-flash` GLM 5.3 Flash. */
function modelName(id) {
	const model = id.trim().replace(/\s*(?:\(\d+(?:\.\d+)?[km] context\)|\[\d+(?:\.\d+)?[km]\])$/i, "");
	const tokens = (model.split("/").filter(Boolean).at(-1) ?? model).split(/[-_\s]+/).filter((token) => token && !/^\d{8}$/.test(token));
	const words = [];
	for (const token of tokens) {
		const previous = words.at(-1);
		if (/^\d+$/.test(token) && previous && /^\d+(\.\d+)*$/.test(previous)) words[words.length - 1] = `${previous}.${token}`;
		else words.push(token);
	}
	const named = words.map((word) => ACRONYMS[word.toLowerCase()] ?? (/^\d/.test(word) || /^o\d/i.test(word) ? word.replace(/b$/i, "B") : word[0].toUpperCase() + word.slice(1)));
	if (named[0] === "GPT" && /^\d/.test(named[1] ?? "")) named.splice(0, 2, `GPT-${named[1]}`);
	return named.join(" ") || "Agent";
}
/** A credit names a model only when it supplies one; "Claude" and "Claude Code" just identify the tool. */
function modelFromCredit(credit) {
	const aider = /^aider \(([^()]+)\)$/i.exec(credit.trim());
	if (aider) return /^[\w./:@-]+$/.test(aider[1]) && !/^(?:unknown(?:-model)?|default)$/i.test(aider[1]) ? modelName(aider[1]) : void 0;
	const name = modelName(credit);
	return /^(?:Claude (?:(?:Opus|Sonnet|Haiku|Fable) )?\d+(?:\.\d+)*(?: (?:Opus|Sonnet|Haiku|Fable))?|GPT-\d[\w. -]*|o\d[\w. -]*|Gemini \d[\w. -]*)$/.test(name) ? name : void 0;
}
/** A tool without its version: `claude-code/2.4.1` is `claude-code`. */
const toolBase = (tool) => tool.split("/").filter((part) => part && !/^v?\d/.test(part)).join("/");
/** A tool such as `claude-code/2.4.1` or `@openai/codex/1.8.0` by name, without its scope or version. */
function toolName(tool) {
	return modelName((toolBase(tool).split("/").at(-1) || tool).replace(/^@/, ""));
}
//#endregion
//#region ../shared/people.ts
/** GitHub's private commit address also names the login, including addresses from before 2017. */
const NOREPLY = /^(?:\d+\+)?([a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.github\.com$/i;
const githubLogin = (email) => email.match(NOREPLY)?.[1];
/** A GitHub App acts under its slug with `[bot]` appended. */
const BOT = /\[bot\]$/i;
const isBotLogin = (login) => BOT.test(login);
const appSlug = (login) => login.replace(BOT, "");
//#endregion
//#region ../shared/provenance.ts
const NOTES_REF = "refs/notes/braid";
const ANTHROPIC = "noreply@anthropic.com";
const AGENT_DOMAIN = "@agents.braid.local";
const emailSlug = (value) => value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64) || "agent";
/**
* How a model would co-author a commit: its display name, with Anthropic's no-reply address for Claude models as
* Claude Code writes it, and a stable `@agents.braid.local` address for others; without a model the tool names it.
* Braid never adds this line itself. Tools that do are read back by `provenanceOf`.
*/
function coAuthor(model, tool) {
	return {
		name: model ? modelName(model) : tool ? toolName(tool) : "Agent",
		email: (model ? /^(?:[\w.-]+\/)*claude/i.test(model) : !!tool && /claude/i.test(tool)) ? ANTHROPIC : `${emailSlug(model ?? (tool ? toolName(tool) : "agent"))}${AGENT_DOMAIN}`
	};
}
const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]{0,63}):[ \t]*(.*)$/;
/** Keys trusted even in a last paragraph that also holds prose, as git trusts its own trailers there. */
const KNOWN = /* @__PURE__ */ new Set([
	"co-authored-by",
	"signed-off-by",
	"braid-change",
	"braid-task",
	"braid-author"
]);
/** Keep fenced examples out of credits without turning an earlier paragraph into a footer. */
function unquotedMessage(message) {
	message = message.replace(/\r\n?/g, "\n");
	if (!message.includes("```") && !message.includes("~~~")) return message;
	let fence;
	return message.split("\n").map((line) => {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = void 0;
			return ">";
		}
		if (marker) {
			fence = marker;
			return ">";
		}
		return line;
	}).join("\n");
}
/** Trailers at the end of a commit, including adjacent trailer blocks tools separate with a blank line. */
function parseTrailers(message) {
	const paragraphs = unquotedMessage(message).trim().split(/\n[ \t]*\n/);
	const block = (text) => text.split("\n").every((line, index) => TRAILER_LINE.test(line) || index > 0 && /^[ \t]/.test(line));
	if (paragraphs.length < 2) {
		const [subject, ...rest] = paragraphs[0].split("\n"), tail = rest.join("\n");
		if (!/^Co-authored-by:/im.test(tail) || !block(tail)) return /* @__PURE__ */ new Map();
		paragraphs.splice(0, 1, subject, tail);
	}
	let first = paragraphs.length - 1;
	while (first > 1 && block(paragraphs[first]) && block(paragraphs[first - 1])) first--;
	const lines = paragraphs.slice(first).join("\n").split("\n");
	const all = lines.every((line, index) => TRAILER_LINE.test(line) || index > 0 && /^[ \t]/.test(line));
	const trailers = /* @__PURE__ */ new Map();
	let last;
	for (const line of lines) {
		const match = TRAILER_LINE.exec(line);
		const key = match?.[1].toLowerCase();
		if (match && key && (all || KNOWN.has(key))) {
			last = trailers.get(key) ?? [];
			last.push(match[2].trim());
			trailers.set(key, last);
		} else if (last && /^[ \t]/.test(line)) last[last.length - 1] = `${last[last.length - 1]} ${line.trim()}`;
		else last = void 0;
	}
	return trailers;
}
/** `Name <email>` as a person; a GitHub no-reply address also names the GitHub login. */
function parsePerson(value) {
	const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value.trim());
	if (!match) return { name: value.trim() };
	const email = match[2], github = /^(?:\d+\+)?([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/i.exec(email)?.[1];
	return {
		name: match[1].trim() || email,
		email,
		...github ? { github } : {}
	};
}
const short = (max) => /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ maxLength(max));
const count$1 = /* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ safeInteger(), /* @__PURE__ */ minValue(1));
const attributionEntries = {
	kind: /* @__PURE__ */ optional$1(/* @__PURE__ */ picklist([
		"agent",
		"human",
		"bot"
	])),
	agent: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: /* @__PURE__ */ optional$1(short(200)),
		name: short(120),
		model: /* @__PURE__ */ optional$1(short(120)),
		tool: /* @__PURE__ */ optional$1(short(80)),
		session: /* @__PURE__ */ optional$1(short(80)),
		parentSession: /* @__PURE__ */ optional$1(short(80)),
		fleet: /* @__PURE__ */ optional$1(short(120))
	})),
	owner: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		name: short(120),
		github: /* @__PURE__ */ optional$1(short(39))
	}))
};
/** Braid's Git note on a commit it landed, under refs/notes/braid. Unknown keys are ignored, so later versions stay readable. */
const noteSchema = /* @__PURE__ */ object({
	v: /* @__PURE__ */ literal(1),
	...attributionEntries,
	files: /* @__PURE__ */ optional$1(/* @__PURE__ */ record(short(240), /* @__PURE__ */ object(attributionEntries))),
	change: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: short(40),
		number: count$1,
		revision: count$1
	})),
	task: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: short(100),
		title: /* @__PURE__ */ optional$1(short(200))
	})),
	approvedBy: /* @__PURE__ */ optional$1(short(400))
});
const noteText = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), noteSchema);
/** A note's text as Braid wrote it, or null when it is not one. */
function parseNote(text) {
	const result = /* @__PURE__ */ safeParse(noteText, text);
	return result.success ? result.output : null;
}
const formatNote = (note) => `${JSON.stringify(note)}\n`;
/** A file's chosen proposal replaces the commit byline, without inheriting another agent's owner or run. */
function fileProvenance(provenance, path) {
	const { files, ...commit } = provenance;
	const author = files && Object.hasOwn(files, path) ? files[path] : void 0;
	return author ? {
		...commit,
		kind: author.kind,
		agent: author.agent,
		owner: author.owner
	} : commit;
}
/** Coding agents recognised by the identities they commit or co-author as. */
const AGENTS = [
	{
		name: "Claude",
		tool: "claude-code",
		login: /^claude\[bot\]$/i,
		email: /^noreply@anthropic\.com$/i
	},
	{
		name: "Codex",
		tool: "codex",
		login: /^(?:chatgpt-codex-connector|codex)\[bot\]$/i,
		email: /^codex@openai\.com$/i
	},
	{
		name: "Copilot",
		tool: "github-copilot",
		login: /^(?:copilot-swe-agent|copilot)(?:\[bot\])?$/i
	},
	{
		name: "Copilot Autofix",
		tool: "github-copilot",
		email: /^(?:\d+\+)?github-advanced-security\[bot\]@users\.noreply\.github\.com$/i,
		emailName: /^Copilot Autofix(?: powered by AI)?$/i
	},
	{
		name: "Cursor",
		tool: "cursor",
		login: /^cursor(?:agent|\[bot\])$/i,
		email: /^cursoragent@cursor\.com$/i
	},
	{
		name: "Cursor Bugbot",
		tool: "cursor-bugbot",
		email: /^bugbot@cursor\.com$/i
	},
	{
		name: "Devin",
		tool: "devin",
		login: /^devin-ai-integration(?:\[bot\])?$/i
	},
	{
		name: "Jules",
		tool: "jules",
		login: /^google-labs-jules(?:\[bot\])?$/i,
		email: /^jules@google\.com$/i
	},
	{
		name: "Gemini",
		tool: "gemini",
		login: /^gemini-code-assist(?:\[bot\])?$/i
	},
	{
		name: "Gemini",
		tool: "gemini-cli",
		login: /^gemini-cli$/i
	},
	{
		name: "Sweep",
		tool: "sweep",
		login: /^sweep-ai(?:-deprecated)?\[bot\]$/i
	},
	{
		name: "Amazon Q",
		tool: "amazon-q",
		login: /^amazon-q-developer\[bot\]$/i
	},
	{
		name: "Aider",
		tool: "aider",
		email: /^(?:aider|noreply)@aider\.(?:chat|dev)$/i
	},
	{
		name: "OpenHands",
		tool: "openhands",
		email: /^openhands@all-hands\.dev$/i
	},
	{
		name: "OpenHands",
		tool: "openhands",
		email: /^contact@all-hands\.dev$/i,
		emailName: /^OpenHands Bot$/i
	}
];
const GENERATED$1 = [
	{
		pattern: /^(?:🤖 )?Generated with (?:Claude Code|\[Claude Code\]\(https:\/\/claude\.(?:ai|com)\/[^\s)]+\))$/i,
		name: "Claude",
		tool: "claude-code"
	},
	{
		pattern: /^(?:🤖 )?Generated (?:with|by) (?:Codex|\[Codex\]\(https:\/\/(?:chatgpt\.com|openai\.com)\/[^\s)]+\))$/i,
		name: "Codex",
		tool: "codex"
	},
	{
		pattern: /^(?:🤖 )?Generated (?:with|by) (?:Cursor|\[Cursor\]\(https:\/\/(?:www\.)?cursor\.com\/?\))$/i,
		name: "Cursor",
		tool: "cursor"
	},
	{
		pattern: /^Generated with \[Devin\]\(https:\/\/devin\.ai\/?\)$/i,
		name: "Devin",
		tool: "devin"
	}
];
const BRANCH = /^Merge pull request #\d+ from [^\s/:]+[/:](?:[a-z0-9]+-)?(codex|claude|cursor|copilot|devin|jules)\/\S+$/i;
/** Other GitHub Apps by the names people know them by: AI reviewers and fixers, and plain automation. */
const BOTS = {
	posthog: {
		name: "PostHog AI",
		tool: "posthog"
	},
	"posthog-eu": {
		name: "PostHog AI",
		tool: "posthog"
	},
	"posthog-us": {
		name: "PostHog AI",
		tool: "posthog"
	},
	"seer-by-sentry": {
		name: "Sentry Seer",
		tool: "sentry"
	},
	sentry: {
		name: "Sentry Seer",
		tool: "sentry"
	},
	coderabbitai: { name: "CodeRabbit" },
	"greptile-apps": { name: "Greptile" },
	dependabot: {
		name: "Dependabot",
		kind: "bot"
	},
	"dependabot-preview": {
		name: "Dependabot",
		tool: "dependabot[bot]",
		kind: "bot"
	},
	renovate: {
		name: "Renovate",
		kind: "bot"
	},
	"github-actions": {
		name: "GitHub Actions",
		kind: "bot"
	},
	"release-please": {
		name: "Release Please",
		kind: "bot"
	},
	"semantic-release-bot": {
		name: "Semantic Release",
		kind: "bot"
	},
	changeset: {
		name: "Changesets",
		kind: "bot"
	}
};
const AUTOMATION = {
	"bot@renovateapp.com": {
		name: "Renovate",
		tool: "renovate[bot]"
	},
	"renovate@whitesourcesoftware.com": {
		name: "Renovate",
		tool: "renovate[bot]"
	},
	"gemini-cli-robot@google.com": {
		name: "Gemini CLI release bot",
		tool: "gemini-cli-robot"
	}
};
const botLogin = (person) => [person.github, person.name].find((value) => value && isBotLogin(value));
const botApp = (login) => {
	const slug = appSlug(login).toLowerCase();
	return Object.hasOwn(BOTS, slug) ? BOTS[slug] : void 0;
};
function knownAgent(person) {
	const known = AGENTS.find((agent) => person.github && agent.login?.test(person.github) || isBotLogin(person.name) && agent.login?.test(person.name) || person.email && agent.email?.test(person.email) && (!agent.emailName || agent.emailName.test(person.name)));
	if (known) return known;
	const login = botLogin(person), app = login && botApp(login);
	return app && app.kind !== "bot" ? {
		name: app.name,
		tool: app.tool ?? login
	} : void 0;
}
/** Whether a paragraph is one of the footers coding tools add to the commits they write. */
const generatedFooter = (paragraph) => GENERATED$1.some((sign) => sign.pattern.test(paragraph.trim()));
function generatedAgent(message) {
	if (!/Generated (?:with|by) /i.test(message)) return void 0;
	const paragraphs = unquotedMessage(message).trim().split(/\n[ \t]*\n/);
	let last = paragraphs.length - 1;
	while (last > 0 && paragraphs[last].split("\n").every((line) => TRAILER_LINE.test(line))) last--;
	return last > 0 ? GENERATED$1.find((sign) => sign.pattern.test(paragraphs[last])) : void 0;
}
/** Known coding identities remain agents; other apps and explicit release identities are plain automation. */
function botOf(person) {
	const known = knownAgent(person);
	if (known) return {
		name: known.name,
		tool: known.tool,
		kind: "agent"
	};
	const automation = person.email && AUTOMATION[person.email.toLowerCase()];
	if (automation) return {
		...automation,
		kind: "bot"
	};
	const login = botLogin(person);
	if (!login) return void 0;
	const bot = botApp(login);
	return {
		name: bot?.name ?? appSlug(login),
		tool: bot?.tool ?? login,
		kind: "bot"
	};
}
const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== void 0 && item !== ""));
/**
* Who made a commit. A model co-authoring under a known agent address (Anthropic's no-reply address, or Braid's
* `@agents.braid.local`) is the agent and the commit's author its owner; Braid's note on the commit, when there is
* one, wins for every detail it has. Then Braid's earlier `Braid-Author` trailer, then the signs coding tools leave.
* Braid's own records of what it landed outrank all of this with confidence `braid`.
*/
function provenanceOf(commit, note) {
	const trailers = parseTrailers(commit.message);
	const one = (key) => trailers.get(key)?.[0] || void 0;
	const base = {
		commit: commit.id,
		at: commit.at,
		subject: commit.message.split("\n", 1)[0].slice(0, 200),
		...note?.files ? { files: Object.fromEntries(Object.entries(note.files).map(([path, author]) => [path, {
			kind: author.kind ?? (author.agent ? "agent" : "human"),
			...author.agent ? { agent: {
				...author.agent,
				name: author.agent.model ? modelName(author.agent.model) : author.agent.name
			} } : {},
			...author.owner ? { owner: author.owner } : {}
		}])) } : {}
	};
	const change = /^#(\d+)\s+((?:ch_[0-9a-f]+|c[0-9]+))$/.exec(one("braid-change") ?? ""), task = /^((?:mission|task|t)[_-][A-Za-z0-9_-]+)(?:\s+(.+))?$/.exec(one("braid-task") ?? "");
	const links = {
		...note?.change ? { change: {
			id: note.change.id,
			number: note.change.number
		} } : change ? { change: {
			id: change[2],
			number: Number(change[1])
		} } : {},
		...note?.task ? { task: defined({
			id: note.task.id,
			title: note.task.title
		}) } : task ? { task: defined({
			id: task[1],
			title: task[2]
		}) } : {}
	};
	const author = parsePerson(`${commit.author.name} <${commit.author.email}>`);
	const aiderAuthor = /^(.+) \(aider\)$/i.exec(author.name);
	const owner = note?.owner ? defined({
		...note.owner,
		email: note.owner.github && note.owner.github === author.github ? author.email : void 0
	}) : aiderAuthor ? {
		...author,
		name: aiderAuthor[1]
	} : author;
	const coAuthors = (trailers.get("co-authored-by") ?? []).map(parsePerson);
	const model = coAuthors.find((person) => person.email && (person.email.toLowerCase() === ANTHROPIC || person.email.toLowerCase().endsWith(AGENT_DOMAIN)));
	const people = [...new Map(coAuthors.filter((person) => !botOf(person) && !person.email?.toLowerCase().endsWith(AGENT_DOMAIN) && !/ \(aider\)$/i.test(person.name)).map((person) => [(person.email ?? person.name).toLowerCase(), person])).values()];
	const humanCoAuthor = people.length === 1 ? people[0] : void 0;
	if (note?.kind === "bot") return {
		...base,
		kind: "bot",
		...note.agent ? { agent: note.agent } : {},
		...links,
		confidence: "trailers"
	};
	if (note && !note.agent) return {
		...base,
		kind: "human",
		owner,
		...links,
		confidence: "trailers"
	};
	const legacy = /^(.+?) \((agent|simulated|human|github)(?:, ([^)]+))?\)$/.exec(one("braid-author") ?? "");
	const legacyAgent = legacy && legacy[2] !== "human" && legacy[2] !== "github";
	const credits = coAuthors.flatMap((person) => {
		const agent = knownAgent(person);
		return agent ? [{
			tool: agent.tool,
			model: modelFromCredit(person.name)
		}] : [];
	});
	const ambiguous = !legacyAgent && !model?.email?.toLowerCase().endsWith(AGENT_DOMAIN) && (new Set(credits.map((credit) => credit.tool)).size > 1 || new Set(credits.flatMap((credit) => credit.model ? [credit.model] : [])).size > 1);
	if (!note && ambiguous) {
		const person = botOf(author) ? humanCoAuthor : owner;
		return {
			...base,
			kind: "agent",
			agent: { name: "Agent" },
			...person ? { owner: person } : {},
			...links,
			confidence: "inferred"
		};
	}
	if (model || note?.agent) {
		const braid = !!model?.email?.toLowerCase().endsWith(AGENT_DOMAIN);
		const generated = generatedAgent(commit.message);
		const bot = botOf(author);
		const modelId = model && (braid ? model.email.slice(0, -19) : modelFromCredit(model.name));
		const named = model && !ambiguous ? defined({
			name: braid ? modelName(model.name) : modelId ?? "Claude",
			model: modelId,
			tool: generated?.tool ?? (aiderAuthor ? "aider" : bot?.kind === "agent" ? bot.tool : void 0) ?? (!braid ? "claude-code" : void 0)
		}) : void 0;
		const agent = defined({
			...named,
			...note?.agent,
			name: note?.agent?.model ? modelName(note.agent.model) : note?.agent?.name ?? named.name
		});
		const person = note?.owner || !bot ? owner : humanCoAuthor;
		return {
			...base,
			kind: "agent",
			agent,
			...person ? { owner: person } : {},
			...links,
			confidence: note || braid ? "trailers" : "inferred"
		};
	}
	if (legacyAgent) return {
		...base,
		kind: "agent",
		agent: defined({
			name: legacy[1],
			model: legacy[3]
		}),
		...links,
		confidence: "trailers"
	};
	const bot = botOf(author);
	const credit = (person, agent) => {
		const model = modelFromCredit(person.name);
		return defined({
			name: model ?? agent.name,
			tool: agent.tool,
			model
		});
	};
	const codingAuthor = knownAgent(author);
	if (codingAuthor) return {
		...base,
		kind: "agent",
		agent: credit(author, codingAuthor),
		...humanCoAuthor ? { owner: humanCoAuthor } : {},
		...links,
		confidence: "inferred"
	};
	for (const person of coAuthors) {
		const agent = knownAgent(person);
		if (!agent) continue;
		const personOwner = bot ? humanCoAuthor : owner;
		return {
			...base,
			kind: "agent",
			agent: credit(person, agent),
			...personOwner ? { owner: personOwner } : {},
			...links,
			confidence: "inferred"
		};
	}
	if (aiderAuthor) return {
		...base,
		kind: "agent",
		agent: {
			name: "Aider",
			tool: "aider"
		},
		owner,
		...links,
		confidence: "inferred"
	};
	const personOwner = bot ? humanCoAuthor : owner;
	const generated = generatedAgent(commit.message);
	const branch = BRANCH.exec(base.subject)?.[1].toLowerCase();
	const fromBranch = branch && AGENTS.find((agent) => agent.tool.includes(branch) || agent.name.toLowerCase() === branch);
	const coding = generated || fromBranch;
	if (coding) return {
		...base,
		kind: "agent",
		agent: {
			name: coding.name,
			tool: coding.tool
		},
		...personOwner ? { owner: personOwner } : {},
		...links,
		confidence: "inferred"
	};
	if (bot) return {
		...base,
		kind: bot.kind,
		agent: {
			name: bot.name,
			tool: bot.tool
		},
		...humanCoAuthor ? { owner: humanCoAuthor } : {},
		...links,
		confidence: "inferred"
	};
	for (const person of coAuthors) {
		const agent = botOf(person);
		if (agent) return {
			...base,
			kind: agent.kind,
			agent: {
				name: agent.name,
				tool: agent.tool
			},
			owner,
			...links,
			confidence: "inferred"
		};
	}
	return {
		...base,
		kind: "human",
		owner,
		...links,
		confidence: note ? "trailers" : "inferred"
	};
}
//#endregion
//#region ../shared/activity-privacy.ts
/** A model/tool identifier is a name, never a machine path or credential. */
const safeActivityIdentity = (value) => /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,119}$/.test(value) && !value.includes("..") && redactPublicText(value) === value;
/** Only a command's known operation leaves the machine. Never arguments, assignments, scripts or output. */
function activityCommand(command) {
	const words = command.trim().split(/\s+/);
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
	const [program, action, script] = words;
	if (/^(npm|pnpm|yarn|bun)$/.test(program ?? "") && /^(test|build|lint|typecheck|check)$/.test(action ?? "")) return `${program} ${action}`;
	if (/^(npm|pnpm|yarn|bun)$/.test(program ?? "") && action === "run" && /^(test(?::[a-z-]+)?|build|lint|typecheck|check)$/.test(script ?? "")) return `${program} run ${script}`;
	if (program === "git" && /^(status|diff|log|show|add|commit|fetch|push|pull|rebase|merge|checkout|switch|branch|rev-parse)$/.test(action ?? "")) return `git ${action}`;
	if (/^(pytest|python|python3|node|deno|tsc|vitest|jest|make|cargo|go|ruby|bundle|sh|bash|zsh|curl|wget|ls|cat|rg|sed)$/.test(program ?? "")) return `${program} [arguments omitted]`;
	return "[command omitted]";
}
/** Defense in depth on the receiving side; absolute paths and traversal are never displayed. */
function activityRelativePath(path) {
	if (!path || path.length > 240 || /[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith("/") || path.startsWith("~") || path.split("/").some((part) => part === ".." || part === ".git")) return "[outside repository]";
	return redactPublicText(path);
}
//#endregion
//#region src/config.ts
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TOKEN = /^[^\x00-\x20\x7f]{1,16384}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function normalizeOrigin(value) {
	if (!URL.canParse(value)) fail("Give the address of your Braid, such as --url https://braid.example.");
	const url = new URL(value);
	if (/[\x00-\x20\x7f\\]/.test(value) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("Use the Braid address alone, without credentials, a path, a query or a fragment.");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname))) fail("Braid needs HTTPS; plain HTTP is allowed only for local development.");
	return url.origin;
}
function originOf(value) {
	try {
		return normalizeOrigin(value);
	} catch (error) {
		if (error instanceof CliError) return void 0;
		throw error;
	}
}
const configRoot = (env) => resolve(env.BRAID_CONFIG_HOME || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "braid"));
/** The file for one origin and repository; without a repository, the origin-wide file earlier releases wrote. */
function credentialFile(env, origin, workspaceId) {
	const root = configRoot(env), key = sha256(normalizeOrigin(origin));
	return workspaceId === void 0 ? join(root, `${key}.json`) : join(root, key, `${sha256(workspaceId)}.json`);
}
function realDirectory(path) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${path} must be a real directory, not a symlink.`);
	return path;
}
function privateDirectory(path) {
	mkdirSync(path, {
		recursive: true,
		mode: 448
	});
	chmodSync(realDirectory(path), 448);
	return path;
}
function readRegularFile(path, max, check) {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > max) return void 0;
		check?.(stat, fd);
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}
/** Makes a completed rename durable where the platform can sync directories. */
function syncDirectory(path) {
	if (process.platform === "win32") return;
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY);
		fsyncSync(fd);
	} catch {} finally {
		if (fd !== void 0) closeSync(fd);
	}
}
/** Replaces a file atomically with owner-only permissions, never writing through a symlink. */
function writePrivate(path, content, { exclusive = false } = {}) {
	if (exclusive) writeFileSync(path, content, {
		mode: 384,
		flag: "wx",
		flush: true
	});
	else {
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`${path} must not be a symlink.`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, content, {
				mode: 384,
				flag: "wx",
				flush: true
			});
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	syncDirectory(dirname(path));
}
const writePrivateJson = (path, data, options) => writePrivate(path, `${JSON.stringify(data, null, 2)}\n`, options);
/**
* A JSON file only this user may read, parsed with `schema`. It must be a regular file of at most `max` bytes owned
* by this user; it is tightened to 0600, or with `readOnly` refused when others can read it. A missing file is
* undefined.
*/
function readPrivateJson(path, schema, { max = 1048576, readOnly = false, label = "Local Braid data" } = {}) {
	let bytes;
	try {
		bytes = readRegularFile(path, max, (stat, fd) => {
			if (process.getuid && stat.uid !== process.getuid()) fail(`${label} at ${path} belongs to another user.`);
			if (readOnly && stat.mode & 63) fail(`${label} at ${path} must be readable only by you (chmod 600).`);
			if (!readOnly) fchmodSync(fd, 384);
		});
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		if (error instanceof CliError) throw error;
		return fail(`Cannot read ${label.toLowerCase()} at ${path}. Check its permissions.`);
	}
	if (!bytes) fail(`${label} at ${path} is not a regular file of at most ${max} bytes.`);
	const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), schema), bytes.toString("utf8"));
	return parsed.success ? parsed.output : fail(`${label} at ${path} is damaged: ${parsed.issues[0].message}`);
}
const stored = /* @__PURE__ */ object({
	origin: /* @__PURE__ */ string(),
	accessToken: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(TOKEN)),
	workspaceId: /* @__PURE__ */ union([/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(ID)), /* @__PURE__ */ literal("*")]),
	expiresAt: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ check((value) => Number.isFinite(Date.parse(value))))
});
function saveCredentials(env, grant) {
	const path = credentialFile(env, grant.origin, grant.workspaceId);
	privateDirectory(dirname(dirname(path)));
	privateDirectory(dirname(path));
	writePrivateJson(path, {
		origin: grant.origin,
		accessToken: grant.accessToken,
		workspaceId: grant.workspaceId,
		expiresAt: grant.expiresAt
	});
	return path;
}
/** One saved file, which must name the origin and, in a repository folder, the repository its name is derived from. */
function readCredential(env, path, origin) {
	const saved = readPrivateJson(path, stored, {
		max: 32768,
		label: "Saved Braid credentials"
	});
	if (!saved) return void 0;
	const folder = dirname(path) !== configRoot(env);
	if (origin && saved.origin !== origin || credentialFile(env, saved.origin, folder ? saved.workspaceId : void 0) !== path) fail(`Saved Braid credentials at ${path} do not match their location. Run braid login again.`);
	return {
		...saved,
		path
	};
}
/**
* Every saved approval, for one origin or all of them, newest expiry first. Earlier releases wrote one origin-wide
* file next to the per-repository folders; it is still read.
*/
function savedCredentials(env, origin) {
	const root = configRoot(env);
	if (!existsSync(root)) return [];
	const keys = origin ? [sha256(origin)] : readdirSync(root).flatMap((name) => /^[a-f0-9]{64}(?:\.json)?$/.test(name) ? [name.slice(0, 64)] : []);
	const records = [];
	for (const key of new Set(keys)) {
		const legacy = readCredential(env, join(root, `${key}.json`), origin);
		if (legacy) records.push(legacy);
		const folder = join(root, key);
		if (!existsSync(folder)) continue;
		for (const name of readdirSync(realDirectory(folder)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).sort()) {
			const record = readCredential(env, join(folder, name), origin);
			if (record) records.push(record);
		}
	}
	return records.sort((a, b) => Date.parse(b.expiresAt ?? "") - Date.parse(a.expiresAt ?? ""));
}
/**
* The approval for an origin. BRAID_ACCESS_TOKEN with BRAID_WORKSPACE_ID overrides the saved files; otherwise the
* repository's own link chooses among them, and a single unexpired approval is used. Several are ambiguous rather
* than guessed.
*/
function loadCredentials(context, origin, workspaceId) {
	const { env } = context, wanted = env.BRAID_WORKSPACE_ID || workspaceId;
	if (wanted !== void 0 && !ID.test(wanted)) fail("BRAID_WORKSPACE_ID is not a Braid repository id.");
	if (env.BRAID_ACCESS_TOKEN) {
		if (!TOKEN.test(env.BRAID_ACCESS_TOKEN)) fail("BRAID_ACCESS_TOKEN is not a Braid token.");
		const workspaces = wanted ? [wanted] : [...new Set(savedCredentials(env, origin).map((record) => record.workspaceId))];
		if (workspaces.length !== 1) fail("Set BRAID_WORKSPACE_ID together with BRAID_ACCESS_TOKEN.");
		return {
			origin,
			accessToken: env.BRAID_ACCESS_TOKEN,
			workspaceId: workspaces[0]
		};
	}
	const saved = savedCredentials(env, origin).filter((record) => !wanted || record.workspaceId === wanted || record.workspaceId === "*");
	const current = saved.filter((record) => Date.parse(record.expiresAt ?? "") > context.now());
	const account = current.find((record) => record.workspaceId === "*");
	if (wanted && account && !current.some((record) => record.workspaceId === wanted)) return {
		...account,
		workspaceId: wanted
	};
	if (new Set(current.filter((record) => record.workspaceId !== "*").map((record) => record.workspaceId)).size > 1) fail(`Several repositories are signed in at ${origin}. Run braid init in the repository, or set BRAID_WORKSPACE_ID.`);
	const selected = current.find((record) => record.workspaceId !== "*");
	if (selected) return selected;
	if (account) return fail("Account connected. Choose a repository with --workspace or BRAID_WORKSPACE_ID.");
	return fail(saved.length ? `Your Braid approval for ${origin} expired. Run braid login again.` : `Not signed in to ${origin}. Run braid login${wanted ? "" : ` --url ${origin}`}.`);
}
const emailFlow = /* @__PURE__ */ object({
	origin: /* @__PURE__ */ string(),
	flowId: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ uuid()),
	expiresAt: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ check((value) => Number.isFinite(Date.parse(value))))
});
/** Where a code Braid emailed waits for the person to read it out, beside the origin's approvals, under a name none has. */
const emailFlowFile = (env, origin, email) => join(configRoot(env), sha256(normalizeOrigin(origin)), `email-${sha256(email.trim().toLowerCase())}.json`);
function saveEmailFlow(env, email, flow) {
	const path = emailFlowFile(env, flow.origin, email);
	privateDirectory(dirname(dirname(path)));
	privateDirectory(dirname(path));
	writePrivateJson(path, flow);
}
const readEmailFlow = (env, origin, email) => readPrivateJson(emailFlowFile(env, origin, email), emailFlow, {
	max: 4096,
	label: "The saved email code request"
});
const removeEmailFlow = (env, origin, email) => rmSync(emailFlowFile(env, origin, email), { force: true });
/** Deletes saved approvals for an origin, or one repository at it, and returns how many were removed. */
function removeCredentials(env, origin, workspaceId) {
	const records = savedCredentials(env, origin).filter((record) => !workspaceId || record.workspaceId === workspaceId);
	for (const record of records) if (record.path) rmSync(record.path, { force: true });
	return records.length;
}
const REPOSITORY_CONFIG = ".braid/config.json";
const linked = /* @__PURE__ */ looseObject({
	url: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	workspaceId: /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(ID)))
});
function readLink(root) {
	const path = join(root, REPOSITORY_CONFIG);
	if (!existsSync(path)) return void 0;
	const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), linked), readFileSync(path, "utf8"));
	return parsed.success ? parsed.output : fail(`${REPOSITORY_CONFIG} is not valid: ${parsed.issues[0].message}`);
}
/** Writes the link, keeping any other settings already in the file. It holds no secret, so it may be committed. */
function writeLink(root, link) {
	const path = join(root, REPOSITORY_CONFIG);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({
		...readLink(root),
		url: link.url,
		workspaceId: link.workspaceId
	}, null, 2)}\n`);
	return path;
}
/**
* The Braid a command talks to: --url, then BRAID_URL, then the repository's link, then the only origin with saved
* credentials.
*/
function resolveOrigin(context, link, flag) {
	const named = flag ?? context.env.BRAID_URL ?? link?.url;
	if (named) return normalizeOrigin(named);
	const origins = [...new Set(savedCredentials(context.env).map((record) => record.origin))];
	if (origins.length === 1) return origins[0];
	return fail(origins.length ? "Several Braid addresses are signed in. Pass --url, or run braid init in the repository." : "Not signed in. Run braid login --url https://your-braid.example.");
}
//#endregion
//#region src/schemas.ts
const commit = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "Expected a full commit id."));
/** Browser links are optional for older servers; only absolute HTTP(S) URLs reach the terminal. */
const htmlUrl = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ url$1(), /* @__PURE__ */ check((value) => /^https?:\/\//.test(value) && !/[\x00-\x20\x7f]/.test(value) && !new URL(value).username && !new URL(value).password));
const token = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(TOKEN, "Expected a token."));
const time = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ check((value) => Number.isFinite(Date.parse(value)), "Expected a time."));
const id = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(ID, "Expected an id."));
/** A change's id, which braid puts in request paths. */
const changeId = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(/^[A-Za-z0-9_-]{1,128}$/, "Expected a change id."));
/** An idempotency key, as Braid accepts it. */
const KEY = /^[a-zA-Z0-9_-]{16,128}$/;
const deviceRequest = /* @__PURE__ */ object({
	deviceCode: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ minLength(16), /* @__PURE__ */ maxLength(200)),
	userCode: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(/^[A-Z0-9-]{4,32}$/)),
	verificationUri: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ url$1()),
	expiresIn: /* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ gtValue(0), /* @__PURE__ */ maxValue(3600)),
	interval: /* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ minValue(1))
});
const grant = /* @__PURE__ */ object({
	accessToken: token,
	tokenType: /* @__PURE__ */ literal("Bearer"),
	expiresAt: time,
	workspaceId: /* @__PURE__ */ union([id, /* @__PURE__ */ literal("*")]),
	scope: /* @__PURE__ */ picklist([
		"read",
		"setup",
		"work",
		"fleet"
	])
});
/** A connection for the person's own proof also names its repository by address. */
const selfGrant = /* @__PURE__ */ object({
	...grant.entries,
	created: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean()),
	initialization: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		accessToken: /* @__PURE__ */ string(),
		branch: /* @__PURE__ */ literal("main")
	})),
	repository: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(/^[^/\s]+\/[^/\s]+$/))
});
/** Without one repository to connect, Braid says why and lists the person's repositories to choose from. */
const repositoryChoice = /* @__PURE__ */ object({
	error: /* @__PURE__ */ string(),
	repositories: /* @__PURE__ */ array(/* @__PURE__ */ string())
});
const emailStarted = /* @__PURE__ */ object({
	flowId: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ uuid()),
	expiresAt: time
});
/** A five-minute access token exchanged for the saved connection, and the agent identity Braid gives it. */
const access = /* @__PURE__ */ object({
	accessToken: /* @__PURE__ */ pipe(token, /* @__PURE__ */ startsWith("braid_at_")),
	tokenType: /* @__PURE__ */ literal("Bearer"),
	expiresAt: time,
	agent: /* @__PURE__ */ object({
		id: /* @__PURE__ */ string(),
		name: /* @__PURE__ */ string()
	}),
	workspaceId: id
});
/** What an access token says about itself; braid reads only the approving person, to show who an agent works for. */
const claims = /* @__PURE__ */ object({
	user: /* @__PURE__ */ object({
		id: /* @__PURE__ */ string(),
		name: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		email: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
	}),
	scope: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
});
const errorBody = /* @__PURE__ */ object({ error: /* @__PURE__ */ string() });
const changeStatus = /* @__PURE__ */ picklist([
	"open",
	"revise",
	"attention",
	"queued",
	"landing",
	"landed",
	"closed"
]);
const dependencyInputs = /* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ union([/* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ safeInteger(), /* @__PURE__ */ minValue(1)), /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(/^ch_[0-9a-f]{13}$/))])), /* @__PURE__ */ maxLength(16));
const dependencyFlag = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ transform((value) => value === "none" ? [] : value.split(",").map((part) => /^[1-9]\d*$/.test(part.trim()) ? Number(part.trim()) : part.trim())), dependencyInputs);
const restackReceipt = /* @__PURE__ */ object({
	key: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(KEY)),
	previousRevision: /* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ safeInteger(), /* @__PURE__ */ minValue(1)),
	pending: /* @__PURE__ */ boolean(),
	origin: /* @__PURE__ */ string(),
	workspaceId: /* @__PURE__ */ string()
});
const changeReference = /* @__PURE__ */ object({
	id: changeId,
	number: /* @__PURE__ */ number(),
	status: changeStatus
});
const pullRequestContext = /* @__PURE__ */ object({
	id: changeId,
	number: /* @__PURE__ */ number(),
	html_url: /* @__PURE__ */ optional$1(htmlUrl),
	status: changeStatus,
	next: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	dependsOn: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference)),
	waitingOn: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference)),
	outdated: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference))
});
const list$2 = (item) => /* @__PURE__ */ optional$1(/* @__PURE__ */ array(item), []);
const command$1 = /* @__PURE__ */ object({
	kind: /* @__PURE__ */ literal("command"),
	revision: /* @__PURE__ */ number(),
	command: /* @__PURE__ */ string(),
	exitCode: /* @__PURE__ */ number(),
	output: /* @__PURE__ */ string(),
	source: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
});
const reviewComment = /* @__PURE__ */ object({
	id: /* @__PURE__ */ string(),
	body: /* @__PURE__ */ string(),
	revision: /* @__PURE__ */ number(),
	createdAt: /* @__PURE__ */ string(),
	inReplyTo: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	resolved: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean()),
	author: /* @__PURE__ */ object({
		name: /* @__PURE__ */ string(),
		kind: /* @__PURE__ */ string(),
		owner: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
			name: /* @__PURE__ */ string(),
			email: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
			github: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
		}))
	}),
	anchor: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		path: /* @__PURE__ */ string(),
		line: /* @__PURE__ */ number(),
		side: /* @__PURE__ */ picklist(["LEFT", "RIGHT"]),
		revision: /* @__PURE__ */ number(),
		position: /* @__PURE__ */ nullable(/* @__PURE__ */ number()),
		outdated: /* @__PURE__ */ boolean()
	}))
});
/** The parts of a change braid prints: where it stands, and everything that sent it back. */
const change$1 = /* @__PURE__ */ object({
	id: changeId,
	number: /* @__PURE__ */ number(),
	html_url: /* @__PURE__ */ optional$1(htmlUrl),
	title: /* @__PURE__ */ string(),
	status: changeStatus,
	closeReason: /* @__PURE__ */ optional$1(/* @__PURE__ */ picklist([
		"abandoned",
		"superseded",
		"rejected"
	])),
	revision: /* @__PURE__ */ number(),
	next: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	landedCommit: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	dependsOn: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference)),
	requiredBy: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference)),
	waitingOn: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference)),
	outdated: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(changeReference)),
	comments: list$2(reviewComment),
	conflicts: list$2(/* @__PURE__ */ object({
		path: /* @__PURE__ */ string(),
		kind: /* @__PURE__ */ string(),
		regions: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(/* @__PURE__ */ object({ baseStart: /* @__PURE__ */ number() })))
	})),
	checks: list$2(/* @__PURE__ */ object({
		revision: /* @__PURE__ */ number(),
		label: /* @__PURE__ */ string(),
		status: /* @__PURE__ */ string(),
		detail: /* @__PURE__ */ string(),
		source: /* @__PURE__ */ string()
	})),
	guards: list$2(/* @__PURE__ */ object({
		kind: /* @__PURE__ */ string(),
		path: /* @__PURE__ */ string(),
		detail: /* @__PURE__ */ string()
	})),
	reviews: list$2(/* @__PURE__ */ object({
		revision: /* @__PURE__ */ number(),
		reviewer: /* @__PURE__ */ string(),
		verdict: /* @__PURE__ */ string(),
		summary: /* @__PURE__ */ string(),
		findings: list$2(/* @__PURE__ */ object({
			path: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
			line: /* @__PURE__ */ optional$1(/* @__PURE__ */ number()),
			message: /* @__PURE__ */ string()
		}))
	})),
	evidence: list$2(/* @__PURE__ */ variant("kind", [command$1, /* @__PURE__ */ object({
		kind: /* @__PURE__ */ literal("screenshot"),
		revision: /* @__PURE__ */ number()
	})])),
	overlaps: list$2(/* @__PURE__ */ object({ number: /* @__PURE__ */ number() }))
});
const trunk = /* @__PURE__ */ object({
	remote: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ url$1()),
	token,
	branch: /* @__PURE__ */ string(),
	head: commit
});
const instructions = /* @__PURE__ */ object({
	instructions: /* @__PURE__ */ array(/* @__PURE__ */ object({
		id: /* @__PURE__ */ string(),
		text: /* @__PURE__ */ string(),
		block: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(/* @__PURE__ */ string())),
		paths: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(/* @__PURE__ */ string()))
	})),
	errors: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(/* @__PURE__ */ string()), [])
});
const owner = /* @__PURE__ */ object({
	id: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	name: /* @__PURE__ */ string(),
	email: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	github: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
});
const attribution = /* @__PURE__ */ object({
	kind: /* @__PURE__ */ picklist([
		"agent",
		"human",
		"bot"
	]),
	agent: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		name: /* @__PURE__ */ string(),
		model: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		tool: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		fleet: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		session: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		parentSession: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
	})),
	owner: /* @__PURE__ */ optional$1(owner)
});
/** `GET /api/provenance?commits=`: what Braid knows about each commit it was asked about and witnessed. */
const provenanceList = /* @__PURE__ */ array(/* @__PURE__ */ object({
	commit: /* @__PURE__ */ string(),
	at: /* @__PURE__ */ string(),
	subject: /* @__PURE__ */ string(),
	...attribution.entries,
	files: /* @__PURE__ */ optional$1(/* @__PURE__ */ record(/* @__PURE__ */ string(), attribution)),
	change: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: /* @__PURE__ */ string(),
		number: /* @__PURE__ */ number()
	})),
	task: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: /* @__PURE__ */ string(),
		title: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
	})),
	confidence: /* @__PURE__ */ picklist([
		"braid",
		"trailers",
		"inferred"
	])
}));
const agentRecords = /* @__PURE__ */ array(/* @__PURE__ */ object({
	id: /* @__PURE__ */ string(),
	name: /* @__PURE__ */ string(),
	owner: /* @__PURE__ */ optional$1(owner),
	models: /* @__PURE__ */ array(/* @__PURE__ */ string()),
	tools: /* @__PURE__ */ array(/* @__PURE__ */ string()),
	fleet: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	changes: /* @__PURE__ */ object({
		landed: /* @__PURE__ */ number(),
		sentBack: /* @__PURE__ */ number(),
		reverted: /* @__PURE__ */ number(),
		open: /* @__PURE__ */ number()
	}),
	lines: /* @__PURE__ */ object({
		added: /* @__PURE__ */ number(),
		alive: /* @__PURE__ */ number()
	}),
	firstActive: /* @__PURE__ */ string(),
	lastActive: /* @__PURE__ */ string(),
	simulated: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal(true))
}));
const text$4 = (max) => /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ trim(), /* @__PURE__ */ nonEmpty(), /* @__PURE__ */ maxLength(max));
const testReports = /* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ object({
	command: text$4(400),
	result: /* @__PURE__ */ picklist([
		"passed",
		"failed",
		"not-run"
	]),
	detail: /* @__PURE__ */ optional$1(text$4(2e3))
}), "The tests file holds a JSON list of {command, result, detail?} reports."), /* @__PURE__ */ maxLength(10, "Report at most 10 tests."));
const evidenceInput = /* @__PURE__ */ variant("kind", [/* @__PURE__ */ object({
	kind: /* @__PURE__ */ literal("screenshot"),
	page: /* @__PURE__ */ string(),
	viewport: /* @__PURE__ */ picklist(["desktop", "mobile"]),
	width: /* @__PURE__ */ number(),
	height: /* @__PURE__ */ number(),
	contentType: /* @__PURE__ */ picklist([
		"image/png",
		"image/jpeg",
		"image/webp"
	]),
	data: /* @__PURE__ */ string()
}), /* @__PURE__ */ object({
	kind: /* @__PURE__ */ literal("command"),
	command: /* @__PURE__ */ string(),
	exitCode: /* @__PURE__ */ number(),
	output: /* @__PURE__ */ string(),
	durationMs: /* @__PURE__ */ optional$1(/* @__PURE__ */ number())
})]);
/** A submission saved before it is sent, so an uncertain answer can be retried with the same body and key. */
const journal = /* @__PURE__ */ object({
	status: /* @__PURE__ */ picklist([
		"pending",
		"complete",
		"rejected"
	]),
	key: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(KEY)),
	target: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(/^\/api\/changes(?:\/[A-Za-z0-9_-]+\/revisions)?$/)),
	payload: /* @__PURE__ */ object({
		title: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		summary: /* @__PURE__ */ string(),
		intent: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		rationale: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		model: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		baseCommit: commit,
		files: /* @__PURE__ */ array(/* @__PURE__ */ object({
			path: /* @__PURE__ */ string(),
			content: /* @__PURE__ */ nullable(/* @__PURE__ */ string()),
			mode: /* @__PURE__ */ optional$1(/* @__PURE__ */ picklist(["100644", "100755"]))
		})),
		dependsOn: /* @__PURE__ */ optional$1(dependencyInputs),
		tests: /* @__PURE__ */ optional$1(testReports),
		evidence: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(evidenceInput)),
		previousRevision: /* @__PURE__ */ optional$1(/* @__PURE__ */ number()),
		agent: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
			tool: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
			session: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
			parentSession: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
		})),
		/** The co-author lines the submitted commits carry, which Braid keeps in the commit it lands. */
		coAuthors: /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ maxLength(200))), /* @__PURE__ */ maxLength(5)))
	})
});
/** The change a branch is working on, kept in the Git directory so it never shows up as a file to commit. */
const branchState = /* @__PURE__ */ object({
	origin: /* @__PURE__ */ string(),
	workspaceId: id,
	base: commit,
	nextBase: /* @__PURE__ */ optional$1(commit),
	change: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		id: changeId,
		number: /* @__PURE__ */ number(),
		revision: /* @__PURE__ */ number(),
		status: changeStatus,
		html_url: /* @__PURE__ */ optional$1(htmlUrl)
	}))
});
//#endregion
//#region src/secrets.ts
/**
* What a credential looks like: the prefixed provider formats Braid's own scanner knows, plus the broader shapes the
* downloadable braid.mjs refuses, such as `password = "…"` assignments and credentials embedded in URLs.
*/
const PATTERNS = [
	...SECRET_RULES.map((rule) => rule.pattern),
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
	/\bbraid_(?:agent|at)_[a-zA-Z0-9_.-]{16,}/,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\bgh[pousr]_[a-zA-Z0-9]{20,}/,
	/\bgithub_pat_[a-zA-Z0-9_]{20,}/,
	/\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}/,
	/\bxox[baprs]-[a-zA-Z0-9-]{16,}/,
	/https?:\/\/[^\s/:"'<>]+:[^\s/@"'<>]+@/,
	/\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_=.-]{12,}/i,
	/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token|_authToken)\b["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
	/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|_authToken)\s*=\s*[a-zA-Z0-9+/_=-]{12,}(?:\s|$)/i
];
const GLOBAL = PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
/** Whether text holds one of the given secrets or anything shaped like a credential. */
const hasSecret = (content, secrets) => secrets.some((secret) => secret.length >= 4 && content.includes(secret)) || PATTERNS.some((pattern) => pattern.test(content));
function assertNoSecrets(content, secrets, message) {
	if (hasSecret(content, secrets)) fail(message);
}
/** Refuses a submission that holds anything shaped like a credential; base64 screenshots are not text, so they are left out. */
function assertSubmittable(payload, secrets) {
	assertNoSecrets(JSON.stringify({
		...payload,
		evidence: payload.evidence?.map((item) => item.kind === "screenshot" ? {
			...item,
			data: ""
		} : item)
	}), secrets, "Possible secret detected. Remove credentials from the files, title, summary, rationale and test reports before submitting.");
}
/** Text with the given secrets and anything shaped like a credential replaced, for printing what others wrote. */
function redact(content, secrets = []) {
	let result = redactEmails(content);
	for (const secret of secrets) if (secret.length >= 4) result = result.replaceAll(secret, "[redacted]");
	for (const pattern of GLOBAL) result = result.replace(pattern, "[redacted]");
	return result;
}
//#endregion
//#region src/terminal.ts
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/** Text from a server, a repository or a command as it may safely reach a terminal: no escape sequences or control characters. */
/** A count with its noun, as people read it: `1 file`, `111,068 lines`. */
const count = (n, noun) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
const plain = (text) => text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(CONTROL, "");
/** A command's output as a person read it: plain text, with a line redrawn by carriage returns as it ended. */
const screenText = (text) => text.replace(ANSI, "").replace(/\r\n/g, "\n").split("\n").map((row) => row.split("\r").findLast(Boolean) ?? "").join("\n").replace(CONTROL, "");
/** One line of text at most `width` characters long, ending in an ellipsis when cut. */
function clip$1(text, width) {
	const characters = [...text];
	return characters.length <= width ? text : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
}
function fitLast(context, rows) {
	if (!rows.length) return;
	const last = rows[0].length - 1, width = context.process.stdout.isTTY ? context.process.stdout.columns ?? 120 : 120;
	let fixed = 0;
	for (let column = 0; column < last; column++) fixed += Math.max(...rows.map((row) => [...row[column]].length)) + 2;
	for (const row of rows) row[last] = clip$1(row[last], Math.max(20, width - fixed));
}
const pad = (text, width) => text + " ".repeat(Math.max(0, width - [...text].length));
/** Colour for stdout when it is a terminal that wants it; NO_COLOR and FORCE_COLOR are honoured. */
function colours(context) {
	const { env, process } = context;
	const enabled = env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : !env.NO_COLOR && env.TERM !== "dumb" && process.stdout.isTTY === true;
	const style = (open, close) => (text) => enabled && text ? `\x1b[${open}m${text}\x1b[${close}m` : text;
	return {
		dim: style(2, 22),
		bold: style(1, 22),
		yellow: style(33, 39),
		cyan: style(36, 39)
	};
}
/** How long ago, in the fewest characters: `now`, `5m`, `3h`, `2d`, `6w`, `5mo`, `2y`. */
function age(at, now) {
	const seconds = Math.max(0, (now - Date.parse(at)) / 1e3);
	if (!Number.isFinite(seconds)) return "";
	for (const [size, unit] of [
		[31536e3, "y"],
		[2592e3, "mo"],
		[604800, "w"],
		[86400, "d"],
		[3600, "h"],
		[60, "m"]
	]) if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
	return "now";
}
/**
* Rows as aligned columns. Cells come from commits and servers, so each is reduced to plain text on one line first;
* every column but the last is padded to its widest cell, and `style` colours a cell after its width is measured, so
* escape codes never skew the alignment.
*/
function columns(rows, style = (cell) => cell) {
	const cells = rows.map((row) => row.map((cell) => plain(cell).replace(/\s/g, " ")));
	const widths = cells.reduce((max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, [...cell].length)), []);
	return cells.map((row, index) => row.map((cell, column) => style(column === row.length - 1 ? cell : pad(cell, widths[column]), column, index)).join("  ").trimEnd());
}
/** A command line quoted for a POSIX shell, so it can be pasted as printed. */
function shellCommand(words) {
	return words.map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`).join(" ");
}
//#endregion
//#region src/api.ts
/** Braid answered, but not with success. `status` lets a command treat, say, a 404 as "not available here". */
var ApiError = class extends CliError {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
/** Sends one request and returns the response, whatever its status; a network failure is reported, never thrown raw. */
async function send(context, url, { method = "GET", body, json = body === void 0 ? void 0 : JSON.stringify(body), headers = {}, timeout = 3e4 } = {}) {
	try {
		return await context.fetch(url, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(timeout),
			headers: {
				accept: "application/json",
				...json === void 0 ? {} : { "content-type": "application/json" },
				...headers
			},
			...json === void 0 ? {} : { body: json }
		});
	} catch {
		return fail(`Braid could not be reached at ${new URL(url).origin}. Check the connection and retry.`);
	}
}
/** A successful answer parsed with `schema`; anything else becomes an ApiError carrying Braid's own explanation. */
async function answer(response, schema, { path, secrets = [] }) {
	const data = await response.json().catch(() => void 0);
	if (!response.ok) {
		const reason = /* @__PURE__ */ safeParse(errorBody, data);
		throw new ApiError(reason.success ? redact(plain(reason.output.error), secrets).slice(0, 2e3) : `Braid answered HTTP ${response.status}.`, response.status);
	}
	const parsed = /* @__PURE__ */ safeParse(schema, data);
	if (!parsed.success) fail(`Braid answered ${path} in a form this version of braid does not understand${parsed.issues[0].path ? ` (${parsed.issues[0].path.map((item) => String(item.key)).join(".")})` : ""}. Update braid and retry.`);
	return parsed.output;
}
function retryAfter(value, now) {
	const wait = value && /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value ?? "") - now;
	return Number.isFinite(wait) ? Math.max(0, wait) : 0;
}
/**
* A signed-in repository. Requests carry a five-minute access token minted from the saved connection, renewed after
* four minutes so long waits never present an expired one; the connection itself only ever goes to
* /api/agent/session.
*/
var Braid = class {
	context;
	credentials;
	#access;
	constructor(context, credentials) {
		this.context = context;
		this.credentials = credentials;
	}
	get origin() {
		return this.credentials.origin;
	}
	/** Values that must never be printed or submitted. */
	get secrets() {
		return [this.credentials.accessToken, ...this.#access ? [this.#access.token] : []];
	}
	async session() {
		if (this.#access && this.context.now() - this.#access.minted < 24e4) return this.#access;
		const response = await send(this.context, `${this.origin}/api/agent/session`, {
			method: "POST",
			body: {},
			headers: this.#headers(this.credentials.accessToken)
		});
		if (response.status === 401) throw new ApiError(`Your Braid approval for ${this.origin} expired or was revoked. Run braid login again.`, 401);
		const granted = await answer(response, access, {
			path: "/api/agent/session",
			secrets: this.secrets
		});
		if (granted.workspaceId !== this.credentials.workspaceId) fail("Braid issued access for a different repository. Run braid login again.");
		this.#access = {
			token: granted.accessToken,
			minted: this.context.now(),
			agent: granted.agent,
			expiresAt: granted.expiresAt
		};
		return this.#access;
	}
	/** The person who approved this connection, read from the access token Braid signed for it. */
	async owner() {
		const { token } = await this.session();
		const payload = token.slice(9).split(".")[0];
		const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), claims), Buffer.from(payload, "base64url").toString("utf8"));
		return parsed.success ? parsed.output.user : void 0;
	}
	async get(path, schema) {
		const { token } = await this.session();
		return answer(await send(this.context, `${this.origin}${path}`, { headers: this.#headers(token) }), schema, {
			path,
			secrets: this.secrets
		});
	}
	/** A write. `key` makes it safe to retry: Braid applies a key once and answers repeats with the first result. */
	async post(path, body, schema, { key = randomUUID(), timeout = 12e4 } = {}) {
		const { token } = await this.session();
		return answer(await send(this.context, `${this.origin}${path}`, {
			method: "POST",
			body,
			timeout,
			headers: {
				...this.#headers(token),
				"idempotency-key": key
			}
		}), schema, {
			path,
			secrets: this.secrets
		});
	}
	#headers(token) {
		return {
			authorization: `Bearer ${token}`,
			"x-braid-workspace": this.credentials.workspaceId
		};
	}
};
//#endregion
//#region src/git.ts
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const ZERO = /^0+$/;
const REGULAR = /* @__PURE__ */ new Set(["100644", "100755"]);
const gitEnv = (env) => ({
	...env,
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0"
});
function gitTry(context, args, { cwd = context.cwd, input, env = context.env, secret = false, secrets = [] } = {}) {
	const result = spawnSync("git", args, {
		cwd,
		input,
		maxBuffer: 536870912,
		timeout: 3e5,
		env: gitEnv(env)
	});
	if (result.error) fail(result.error.code === "ENOENT" ? "Git is not installed or not on PATH." : "Git could not run.");
	return {
		status: result.status ?? 1,
		stdout: result.stdout,
		stderr: secret ? "" : redact(plain(result.stderr.toString("utf8")), secrets).trim(),
		withheld: secret
	};
}
function gitFailed(command, said, status) {
	return fail(`git ${command} failed: ${said.trim().split("\n")[0].replace(/^(?:fatal|error): /, "") || `exit ${status}`}`);
}
function succeeded(args, result) {
	if (result.status === 0) return result.stdout;
	return result.withheld ? fail("Git could not complete the operation. Its output is withheld because it involved a Braid token.") : gitFailed(args[0], result.stderr, result.status);
}
const git = (context, args, options) => succeeded(args, gitTry(context, args, options));
const gitText = (context, args, options) => git(context, args, options).toString("utf8").trim();
async function gitAsync(context, args, cwd) {
	const child = spawn("git", args, {
		cwd,
		env: gitEnv(context.env),
		timeout: 3e5,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	const output = [], errors = [];
	child.stdout.on("data", (chunk) => output.push(chunk));
	child.stderr.on("data", (chunk) => errors.push(chunk));
	const status = await new Promise((done, reject) => {
		child.once("error", reject);
		child.once("close", (code) => done(code ?? 1));
	});
	return status === 0 ? Buffer.concat(output) : gitFailed(args[0], redact(plain(Buffer.concat(errors).toString("utf8"))), status);
}
function findRoot(context) {
	const result = gitTry(context, ["rev-parse", "--show-toplevel"]);
	return result.status === 0 ? realpathSync(result.stdout.toString("utf8").trim()) : void 0;
}
const repositoryRoot = (context) => findRoot(context) ?? fail("Run braid inside a Git repository.");
function gitPath(context, root, name) {
	const path = gitText(context, [
		"rev-parse",
		"--git-path",
		name
	], { cwd: root });
	return isAbsolute(path) ? path : resolve(root, path);
}
function currentBranch(context, root) {
	const result = gitTry(context, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD"
	], { cwd: root });
	return result.status === 0 ? result.stdout.toString("utf8").trim() : void 0;
}
function resolveCommit(context, root, revision) {
	const result = gitTry(context, [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${revision}^{commit}`
	], { cwd: root });
	return result.status === 0 ? result.stdout.toString("utf8").trim() : fail(`${revision} is not a commit in this repository.`);
}
const isAncestor = (context, root, ancestor, commit = "HEAD") => gitTry(context, [
	"merge-base",
	"--is-ancestor",
	ancestor,
	commit
], { cwd: root }).status === 0;
const hasCommit = (context, root, commit) => gitTry(context, [
	"cat-file",
	"-e",
	`${commit}^{commit}`
], { cwd: root }).status === 0;
const LOG_FORMAT = ["-z", "--format=%H%n%aN%n%aE%n%aI%n%B"];
function parseCommit(record) {
	const [id, name, email, at] = record.split("\n", 4);
	const message = record.split("\n").slice(4).join("\n").replace(/\n+$/, "");
	return {
		id,
		at,
		author: {
			name,
			email
		},
		message,
		time: Date.parse(at)
	};
}
function readCommits(context, root, ids, since) {
	const wanted = ids.filter((id) => !ZERO.test(id));
	if (!wanted.length) return /* @__PURE__ */ new Map();
	const threshold = since ? /^--max-age=(-?\d+)$/.exec(gitText(context, ["rev-parse", `--since=${since}`], { cwd: root }))?.[1] ?? fail("Git did not understand the --since date.") : void 0;
	const output = git(context, [
		"log",
		"--no-walk=unsorted",
		"--stdin",
		...LOG_FORMAT,
		...threshold ? [`--since=@${Number(threshold) + 1}`] : []
	], {
		cwd: root,
		input: `${wanted.join("\n")}\n`
	}).toString("utf8");
	return new Map(output.split("\0").filter(Boolean).map((record) => {
		const facts = parseCommit(record);
		return [facts.id, facts];
	}));
}
function noteIndex(context, root, ref) {
	const result = gitTry(context, [
		"notes",
		`--ref=${ref}`,
		"list"
	], { cwd: root });
	const index = /* @__PURE__ */ new Map();
	if (result.status !== 0) return index;
	for (const line of result.stdout.toString("utf8").split("\n")) {
		const [note, commit] = line.split(" ");
		if (note && commit) index.set(commit, note);
	}
	return index;
}
function readNotes(context, root, ref, ids, index = noteIndex(context, root, ref)) {
	const wanted = [...new Set(ids)].flatMap((commit) => {
		const note = index.get(commit);
		return note ? [[commit, note]] : [];
	});
	const notes = /* @__PURE__ */ new Map();
	if (!wanted.length) return notes;
	const output = git(context, ["cat-file", "--batch"], {
		cwd: root,
		input: `${wanted.map(([, note]) => note).join("\n")}\n`
	});
	let offset = 0;
	for (const [commit] of wanted) {
		const end = output.indexOf(10, offset);
		const header = /^([0-9a-f]+) blob (\d+)$/.exec(output.subarray(offset, end).toString("utf8"));
		if (!header) break;
		const size = Number(header[2]);
		notes.set(commit, output.subarray(end + 1, end + 1 + size).toString("utf8"));
		offset = end + 1 + size + 1;
	}
	return notes;
}
async function* streamCommits(context, root, args) {
	const child = spawn("git", [
		"log",
		...LOG_FORMAT,
		...args
	], {
		cwd: root,
		env: gitEnv(context.env),
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	let errors = "";
	child.stderr.on("data", (chunk) => {
		errors += chunk.toString("utf8");
	});
	const closed = new Promise((done) => child.once("close", (code) => done(code ?? 1)));
	let pending = Buffer.alloc(0), finished = false;
	try {
		for await (const chunk of child.stdout) {
			pending = Buffer.concat([pending, chunk]);
			for (let end = pending.indexOf(0); end >= 0; end = pending.indexOf(0)) {
				const record = pending.subarray(0, end).toString("utf8");
				pending = pending.subarray(end + 1);
				if (record) yield parseCommit(record);
			}
		}
		if (pending.length) yield parseCommit(pending.toString("utf8"));
		finished = true;
	} finally {
		if (!finished) child.kill();
	}
	const status = await closed;
	if (status !== 0) gitFailed("log", redact(plain(errors)), status);
}
function parseBlame(output) {
	const lines = [];
	let current;
	for (const row of output.split("\n")) if (!current) {
		const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(row);
		if (header) current = {
			commit: header[1],
			line: Number(header[2])
		};
	} else if (row.startsWith("	")) {
		lines[current.line - 1] = {
			commit: current.commit,
			text: row.slice(1).replace(/\r$/, "")
		};
		current = void 0;
	}
	return lines;
}
function blame(context, root, path, commit) {
	return parseBlame(git(context, [
		"blame",
		"--porcelain",
		...commit ? [commit] : [],
		"--",
		path
	], { cwd: root }).toString("utf8"));
}
const HARDENED = [
	"-c",
	`core.hooksPath=${NULL_DEVICE}`,
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.autocrlf=false",
	"-c",
	"credential.helper=",
	"-c",
	"http.followRedirects=false",
	"-c",
	"protocol.allow=never",
	"-c",
	"protocol.https.allow=always"
];
const ASKPASS = "#!/usr/bin/env node\nconst prompt = process.argv[2] || \"\";\nif (prompt.startsWith(\"Username\")) process.stdout.write(\"x\\n\");\nelse if (prompt.startsWith(\"Password\")) process.stdout.write(process.env.BRAID_GIT_TOKEN + \"\\n\");\nelse process.exitCode = 1;\n";
/** Git that runs none of the repository's hooks or configuration. A token reaches it only through a temporary askpass helper, never in arguments or a credential store. */
function strictGit(context, args, { cwd = context.cwd, token, quiet = !!token } = {}) {
	const env = {
		...Object.fromEntries(Object.entries(context.env).filter(([key]) => !/^(?:GIT_|BRAID_)/i.test(key))),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
		GIT_ATTR_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		LC_ALL: "C"
	};
	const run = (extra = {}) => gitTry(context, [...HARDENED, ...args], {
		cwd,
		env: {
			...env,
			...extra
		},
		secret: quiet,
		secrets: token ? [token] : []
	});
	if (!token) return run();
	const folder = mkdtempSync(join(tmpdir(), "braid-askpass-"));
	try {
		chmodSync(folder, 448);
		const helper = join(folder, "askpass.cjs");
		writeFileSync(helper, ASKPASS, {
			mode: 448,
			flag: "wx"
		});
		return run({
			GIT_ASKPASS: helper,
			BRAID_GIT_TOKEN: token
		});
	} finally {
		rmSync(folder, {
			recursive: true,
			force: true
		});
	}
}
const strict = (context, args, options) => succeeded(args, strictGit(context, args, options));
function httpsRemote(value) {
	if (!URL.canParse(value) || /[\x00-\x20\x7f\\]/.test(value)) fail("Braid returned a Git remote that is not plain HTTPS.");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("Braid returned a Git remote that is not plain HTTPS.");
	return url.href;
}
function fetchCommit(context, root, remote, commit, token) {
	if (hasCommit(context, root, commit)) return;
	strict(context, [
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		"--no-write-fetch-head",
		"--no-auto-maintenance",
		"--",
		httpsRemote(remote),
		commit
	], {
		cwd: root,
		token
	});
	if (!hasCommit(context, root, commit)) fail(`Braid's trunk commit ${commit} could not be fetched.`);
}
//#endregion
//#region src/repository.ts
function openRepository(context) {
	const root = repositoryRoot(context);
	return {
		root,
		link: readLink(root)
	};
}
function findRepository(context) {
	const root = findRoot(context);
	return root === void 0 ? void 0 : {
		root,
		link: readLink(root)
	};
}
const braidRemote = (origin, workspaceId) => `${origin}/git/${workspaceId}.git`;
function currentRemote(context, root) {
	const result = gitTry(context, [
		"remote",
		"get-url",
		"braid"
	], { cwd: root });
	return result.status === 0 ? result.stdout.toString("utf8").trim() : void 0;
}
/** A signed-in connection to the repository's Braid. */
function connect(context, repository, url) {
	const credentials = loadCredentials(context, resolveOrigin(context, repository?.link, url), repository?.link?.workspaceId);
	if (repository?.link?.workspaceId && credentials.workspaceId !== repository.link.workspaceId) fail(`This repository is linked to ${repository.link.workspaceId}, but BRAID_WORKSPACE_ID names ${credentials.workspaceId}.`);
	return new Braid(context, credentials);
}
/** The connection when one is set up, for commands that work offline and only get better online. */
function maybeConnect(context, repository) {
	try {
		return connect(context, repository);
	} catch (error) {
		if (error instanceof CliError) return void 0;
		throw error;
	}
}
/**
* Where braid keeps a branch's change: the change and its base, the last submission (kept until it is confirmed, so
* an uncertain one can be resent exactly) and a lock. They live in the Git directory, per worktree, so they never
* appear as files to commit.
*/
function branchFiles(context, root) {
	const folder = privateDirectory(gitPath(context, root, "braid"));
	const branch = currentBranch(context, root);
	const key = encodeURIComponent(branch ?? "HEAD");
	return {
		folder,
		branch,
		state: join(folder, `${key}.json`),
		journal: join(folder, `${key}.submission.json`),
		lock: join(folder, `${key}.lock`)
	};
}
/** braid.mjs's `change start` checkouts keep their change in .braid/change.json; it carries over the first time. */
const legacyChange = /* @__PURE__ */ object({
	origin: /* @__PURE__ */ string(),
	workspaceId: /* @__PURE__ */ string(),
	base: commit,
	nextBase: /* @__PURE__ */ optional$1(commit),
	changeId: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	number: /* @__PURE__ */ optional$1(/* @__PURE__ */ number()),
	revision: /* @__PURE__ */ optional$1(/* @__PURE__ */ number())
});
function readState(root, files) {
	const saved = readPrivateJson(files.state, branchState, { label: "Braid change state" });
	if (saved) return saved;
	const legacy = join(root, ".braid", "change.json");
	if (!existsSync(legacy)) return void 0;
	const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), legacyChange), readFileSync(legacy, "utf8"));
	if (!parsed.success) return void 0;
	const { origin, workspaceId, base, nextBase, changeId, number, revision } = parsed.output;
	return {
		origin,
		workspaceId,
		base,
		nextBase,
		...changeId && number && revision ? { change: {
			id: changeId,
			number,
			revision,
			status: "open"
		} } : {}
	};
}
const writeState = (files, state) => writePrivateJson(files.state, state);
const readJournal = (files) => readPrivateJson(files.journal, journal, {
	max: 50331648,
	label: "The saved submission"
});
const writeJournal = (files, saved) => writePrivateJson(files.journal, saved);
/** Whether a process is running; one this user may not signal still is. */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}
/** Holds a lock file while `work` runs, so two submissions from one branch or checkout never interleave. A lock left by a process that is gone is taken over. */
async function withLock(lock, work) {
	const owner = /* @__PURE__ */ object({ pid: /* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ safeInteger(), /* @__PURE__ */ minValue(1)) });
	try {
		writePrivateJson(lock, { pid: process.pid }, { exclusive: true });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const held = readPrivateJson(lock, owner, {
			max: 1024,
			label: "The submission lock"
		});
		if (held && processAlive(held.pid)) fail(`Another braid command (process ${held.pid}) is submitting from here. Wait for it to finish.`);
		unlinkSync(lock);
		writePrivateJson(lock, { pid: process.pid }, { exclusive: true });
	}
	try {
		return await work();
	} finally {
		unlinkSync(lock);
	}
}
//#endregion
//#region src/activity-hooks.ts
const hook = /* @__PURE__ */ object({
	hook_event_name: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	type: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	cwd: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	tool_name: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	notification_type: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	tool_input: /* @__PURE__ */ optional$1(/* @__PURE__ */ object({
		file_path: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		notebook_path: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		command: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
	})),
	tool_response: /* @__PURE__ */ optional$1(/* @__PURE__ */ unknown()),
	error: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
});
const result = /* @__PURE__ */ object({
	exit_code: /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ integer(), /* @__PURE__ */ minValue(0), /* @__PURE__ */ maxValue(255))),
	exitCode: /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ number(), /* @__PURE__ */ integer(), /* @__PURE__ */ minValue(0), /* @__PURE__ */ maxValue(255)))
});
const activityModel = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ check(safeActivityIdentity));
const sessionModel = /* @__PURE__ */ object({
	hook_event_name: /* @__PURE__ */ literal("SessionStart"),
	model: activityModel
});
function hookModel(raw) {
	const parsed = /* @__PURE__ */ safeParse(sessionModel, raw);
	return parsed.success ? parsed.output.model : void 0;
}
/** Resolve existing ancestors too: a symlink inside the checkout may point outside it. */
function localPath(root, path) {
	let target = resolve(root, path), ancestor = target;
	try {
		for (;;) try {
			target = resolve(realpathSync(ancestor), relative(ancestor, target));
			break;
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		const local = relative(realpathSync(root), target);
		if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return "[outside repository]";
		return activityRelativePath(local.split(sep).join("/"));
	} catch {
		return "[outside repository]";
	}
}
/** Parses only known fields, discarding prompts, content, stdout, stderr and notification prose immediately. */
function hookObservation(raw, root, source) {
	const parsed = /* @__PURE__ */ safeParse(hook, raw);
	if (!parsed.success) return;
	const value = parsed.output;
	if (source === "codex-notify") return value.type === "agent-turn-complete" ? {
		source,
		kind: "waiting"
	} : void 0;
	const event = value.hook_event_name;
	if (event === "SessionStart" || event === "UserPromptSubmit") return {
		source,
		kind: "working"
	};
	if (event === "Stop") return {
		source,
		kind: "waiting"
	};
	if (event === "Notification") return [
		"permission_prompt",
		"idle_prompt",
		"elicitation_dialog"
	].includes(value.notification_type ?? "") ? {
		source,
		kind: "waiting"
	} : void 0;
	if (![
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure"
	].includes(event ?? "")) return;
	const input = value.tool_input;
	if (value.tool_name === "AskUserQuestion") return {
		source,
		kind: "waiting"
	};
	if ([
		"Edit",
		"Write",
		"MultiEdit",
		"NotebookEdit"
	].includes(value.tool_name ?? "")) return {
		source,
		kind: "editing",
		...input?.file_path || input?.notebook_path ? { path: localPath(root, resolve(value.cwd ?? root, input.file_path ?? input.notebook_path)) } : {}
	};
	if (value.tool_name === "Bash" && input?.command) {
		const response = /* @__PURE__ */ safeParse(result, value.tool_response);
		const explicit = response.success ? response.output.exit_code ?? response.output.exitCode : void 0;
		const failure = event === "PostToolUseFailure" ? /(?:Exit code|exit code|exited with (?:code|status))[: ]+(\d{1,3})\b/.exec(value.error ?? "") : null;
		const exitCode = explicit ?? (failure && Number(failure[1]) <= 255 ? Number(failure[1]) : void 0);
		return {
			source,
			kind: event === "PostToolUseFailure" && exitCode === void 0 ? "failed" : "command",
			command: activityCommand(input.command),
			...exitCode === void 0 ? event === "PostToolUse" ? { completed: true } : {} : { exitCode }
		};
	}
	return event === "PreToolUse" ? {
		source,
		kind: "working"
	} : void 0;
}
/** Session-only configuration. No user or repository settings file is modified. */
function installActivityHooks(context, command, tool) {
	const unchanged = {
		command,
		description: "start, exit and commits",
		cleanup() {}
	};
	if (!context.script || !["claude-code", "codex"].includes(tool ?? "")) return unchanged;
	let folder;
	const cleanup = () => {
		try {
			if (folder) rmSync(folder, {
				recursive: true,
				force: true
			});
		} catch {}
	};
	const offset = /^(node|nodejs|bun)(?:\.exe)?$/.test(basename(command[0])) ? 2 : 1;
	try {
		folder = mkdtempSync(join(tmpdir(), "braid-activity-"));
		if (tool === "codex") {
			const notify = [
				process.execPath,
				context.script,
				"hook",
				"activity",
				"codex"
			];
			return {
				command: [
					...command.slice(0, offset),
					"-c",
					`notify=${JSON.stringify(notify)}`,
					...command.slice(offset)
				],
				description: "turn completion, start, exit and commits",
				cleanup
			};
		}
		const args = [...command];
		let settings = {};
		for (let i = offset; i < args.length; i++) {
			if (args[i] !== "--settings" && !args[i].startsWith("--settings=")) continue;
			const inline = args[i].startsWith("--settings="), supplied = inline ? args[i].slice(11) : args[i + 1];
			if (!supplied) {
				cleanup();
				return unchanged;
			}
			const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ unknown()), JSON.parse(supplied.trim().startsWith("{") ? supplied : readFileSync(resolve(context.cwd, supplied), "utf8")));
			if (!parsed.success) {
				cleanup();
				return unchanged;
			}
			settings = {
				...settings,
				...parsed.output
			};
			args.splice(i, inline ? 1 : 2);
			i--;
		}
		const existing = /* @__PURE__ */ safeParse(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ array(/* @__PURE__ */ unknown())), settings.hooks ?? {});
		if (!existing.success || settings.disableAllHooks === true || args.includes("--bare") || args.includes("--safe-mode")) {
			cleanup();
			return unchanged;
		}
		const hooks = existing.output;
		for (const name of [
			"SessionStart",
			"PreToolUse",
			"PostToolUse",
			"PostToolUseFailure",
			"Notification",
			"Stop",
			"UserPromptSubmit"
		]) hooks[name] = [...hooks[name] ?? [], { hooks: [{
			type: "command",
			command: shellCommand([
				process.execPath,
				context.script,
				"hook",
				"activity",
				"claude"
			]),
			async: true
		}] }];
		const file = join(folder, "settings.json");
		writeFileSync(file, JSON.stringify({
			...settings,
			hooks
		}), { mode: 384 });
		return {
			command: [
				...args.slice(0, offset),
				"--settings",
				file,
				...args.slice(offset)
			],
			description: "steps, files, commands, waiting, exit and commits",
			cleanup,
			file
		};
	} catch {
		cleanup();
		return unchanged;
	}
}
//#endregion
//#region src/activity.ts
const text$3 = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ maxLength(240));
const eventSchema = /* @__PURE__ */ object({
	id: text$3,
	sequence: /* @__PURE__ */ number(),
	at: text$3,
	source: /* @__PURE__ */ picklist([
		"process",
		"claude-hook",
		"codex-notify",
		"git"
	]),
	kind: /* @__PURE__ */ picklist([
		"started",
		"working",
		"editing",
		"command",
		"waiting",
		"finished",
		"failed",
		"commit"
	]),
	path: /* @__PURE__ */ optional$1(text$3),
	command: /* @__PURE__ */ optional$1(text$3),
	exitCode: /* @__PURE__ */ optional$1(/* @__PURE__ */ number()),
	commit: /* @__PURE__ */ optional$1(text$3),
	completed: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean())
});
const metadataSchema = /* @__PURE__ */ object({
	origin: text$3,
	workspaceId: text$3,
	session: text$3,
	root: /* @__PURE__ */ string(),
	branch: /* @__PURE__ */ nullable(/* @__PURE__ */ string()),
	pid: /* @__PURE__ */ number(),
	tool: /* @__PURE__ */ optional$1(text$3),
	model: /* @__PURE__ */ optional$1(text$3),
	changeId: /* @__PURE__ */ optional$1(text$3),
	changeNumber: /* @__PURE__ */ optional$1(/* @__PURE__ */ number()),
	changeUrl: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	closed: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean())
});
const stateSchema = /* @__PURE__ */ object({
	retryAt: /* @__PURE__ */ number(),
	attempts: /* @__PURE__ */ number(),
	lastError: /* @__PURE__ */ optional$1(text$3),
	sentChange: /* @__PURE__ */ optional$1(text$3),
	heartbeat: /* @__PURE__ */ optional$1(/* @__PURE__ */ number())
});
const ack = /* @__PURE__ */ object({ accepted: /* @__PURE__ */ array(/* @__PURE__ */ string()) });
const emptyState = {
	retryAt: 0,
	attempts: 0
};
const activityFolder = (context, root) => gitPath(context, root, "braid/activity");
const metadata = (folder) => readPrivateJson(join(folder, "run.json"), metadataSchema);
const delivery = (folder) => readPrivateJson(join(folder, "delivery.json"), stateSchema) ?? emptyState;
const pending = (folder) => readdirSync(folder).filter((name) => /^event-[A-Za-z0-9_-]+\.json$/.test(name));
const runs = (folder) => existsSync(folder) ? readdirSync(folder).filter((name) => /^s_[A-Za-z0-9_-]+$/.test(name)).map((name) => join(folder, name)) : [];
function queueActivity(folder, event, now = Date.now()) {
	const id = randomUUID();
	const observed = {
		...event,
		id,
		at: new Date(now).toISOString(),
		sequence: now * 1e3 + Math.floor(Math.random() * 1e3)
	};
	writePrivateJson(join(folder, `event-${id}.json`), observed, { exclusive: true });
	return observed;
}
/** This is deliberately local-only; launching the agent never waits for a network request. */
function beginActivity(context, repository, session, model, tool) {
	const origin = resolveOrigin(context, repository.link);
	const workspaceId = repository.link?.workspaceId ?? context.env.BRAID_WORKSPACE_ID;
	if (!workspaceId) throw new CliError("Run braid init to link this checkout before reporting activity.");
	if (context.env.BRAID_WORKSPACE_ID && context.env.BRAID_WORKSPACE_ID !== workspaceId) throw new CliError(`Wrong repository in BRAID_WORKSPACE_ID. Unset it and run braid init --workspace ${workspaceId}.`);
	const expected = braidRemote(origin, workspaceId), remote = currentRemote(context, repository.root);
	if (remote !== void 0 && remote !== expected) throw new CliError(`Wrong braid remote. Run git remote set-url braid ${expected}, then braid init.`);
	const folder = privateDirectory(join(privateDirectory(activityFolder(context, repository.root)), session));
	const state = readState(repository.root, branchFiles(context, repository.root));
	const linked = state?.origin === origin && state.workspaceId === workspaceId && state.change && !["landed", "closed"].includes(state.change.status) ? state.change : void 0;
	const run = {
		origin: normalizeOrigin(origin),
		workspaceId,
		root: repository.root,
		session,
		branch: currentBranch(context, repository.root) ?? null,
		pid: process.pid,
		...model && /* @__PURE__ */ is(activityModel, model) ? { model } : {},
		...tool && safeActivityIdentity(tool) ? { tool } : {},
		...linked ? {
			changeId: linked.id,
			changeNumber: linked.number,
			changeUrl: linked.html_url
		} : {}
	};
	writePrivateJson(join(folder, "run.json"), run);
	queueActivity(folder, {
		source: "process",
		kind: "started"
	}, context.now());
	let error;
	try {
		loadCredentials(context, origin, workspaceId);
	} catch (reason) {
		error = reason instanceof CliError ? reason.message : "Run braid login to connect.";
	}
	return {
		folder,
		run,
		error
	};
}
function finishActivity(folder, exitCode, now = Date.now()) {
	queueActivity(folder, {
		source: "process",
		kind: exitCode === 0 ? "finished" : "failed",
		exitCode
	}, now);
	const run = metadata(folder);
	if (run) writePrivateJson(join(folder, "run.json"), {
		...run,
		closed: true
	});
}
/** One bounded batch per run every two seconds. Acked files alone are removed, including after an uncertain retry. */
async function flushActivity(context, folder, force = false) {
	const run = metadata(folder);
	if (!run) return false;
	const state = delivery(folder), now = context.now();
	if (!force && state.retryAt > now) return true;
	const active = !run.closed && processAlive(run.pid);
	const candidates = pending(folder).map((file) => ({
		file,
		event: readPrivateJson(join(folder, file), eventSchema, { max: 2048 })
	})).sort((a, b) => a.event.sequence - b.event.sequence).slice(0, 40);
	const files = [];
	let bytes = 0;
	for (const item of candidates) {
		const size = Buffer.byteLength(JSON.stringify(item.event)) + 1;
		if (bytes + size > 28e3) break;
		files.push(item);
		bytes += size;
	}
	const attachment = !!run.changeId && state.sentChange !== run.changeId;
	if (!files.length && !attachment && (!active || now - (state.heartbeat ?? 0) < 15e3)) return active;
	const model = readPrivateJson(join(folder, "model.json"), /* @__PURE__ */ object({ model: activityModel }))?.model ?? run.model;
	const body = {
		session: run.session,
		model,
		tool: run.tool,
		changeId: run.changeId,
		active,
		events: files.map((item) => item.event)
	};
	let wait = 0;
	try {
		const credentials = loadCredentials(context, run.origin, run.workspaceId);
		if (credentials.workspaceId !== run.workspaceId) throw new CliError("Wrong repository connection. Unset BRAID_WORKSPACE_ID and run braid login.");
		const response = await context.fetch(`${run.origin}/api/local-activity`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(2500),
			headers: {
				authorization: `Bearer ${credentials.accessToken}`,
				"x-braid-workspace": run.workspaceId,
				"content-type": "application/json"
			},
			body: JSON.stringify(body)
		});
		wait = retryAfter(response.headers.get("retry-after"), now);
		if (!response.ok) {
			await response.body?.cancel();
			throw new CliError(response.status === 401 ? "Connection expired or revoked; run braid login. Work continues and events are queued." : response.status === 403 ? "Connection cannot report to this repository; run braid login and choose this repository. Events are queued." : response.status === 400 || response.status === 413 ? "Braid rejected the activity format. Update braid; events remain queued." : "Braid is unavailable. Work continues and events are queued.");
		}
		const parsed = /* @__PURE__ */ safeParse(ack, await response.json());
		if (!parsed.success) throw new CliError("Braid did not acknowledge activity. Work continues and events are queued.");
		const accepted = new Set(parsed.output.accepted);
		for (const item of files) if (accepted.has(item.event.id)) rmSync(join(folder, item.file), { force: true });
		writePrivateJson(join(folder, "delivery.json"), {
			retryAt: now + 2e3,
			attempts: 0,
			heartbeat: now,
			...run.changeId ? { sentChange: run.changeId } : {}
		});
		return active || pending(folder).length > 0;
	} catch (error) {
		const lastError = error instanceof CliError ? error.message : "Braid is unavailable. Work continues and events are queued.";
		const delay = Math.max(wait, Math.min(6e4, 2e3 * 2 ** Math.min(state.attempts, 5)));
		writePrivateJson(join(folder, "delivery.json"), {
			...state,
			attempts: state.attempts + 1,
			retryAt: now + delay,
			lastError: lastError.slice(0, 240)
		});
		return true;
	}
}
/** Detached from the agent's terminal; a short per-checkout lock prevents duplicate senders. */
function startActivityUpload(context, root) {
	if (!context.script) return;
	const child = spawn(process.execPath, [
		context.script,
		"hook",
		"upload",
		root
	], {
		cwd: root,
		env: { ...context.env },
		detached: true,
		stdio: "ignore"
	});
	child.on("error", () => {});
	child.unref();
}
async function uploadActivity(context, root) {
	const folder = activityFolder(context, root);
	if (!existsSync(folder)) return;
	try {
		await withLock(join(folder, "upload.lock"), async () => {
			for (;;) {
				let keep = false;
				for (const run of runs(folder)) keep = await flushActivity(context, run) || keep;
				if (!keep) break;
				await context.sleep(2e3);
			}
		});
	} catch {}
}
/** A hook only reduces and spools data; it never talks to Braid or influences the tool. */
async function recordActivityHook(context, source, payload) {
	try {
		const folder = context.env.BRAID_ACTIVITY_DIR;
		if (!folder) return;
		const run = metadata(folder);
		if (!run) return;
		const raw = payload ?? await context.input();
		if (Buffer.byteLength(raw) > 1048576) return;
		const parsed = JSON.parse(raw);
		const model = source === "claude" ? hookModel(parsed) : void 0;
		if (model) writePrivateJson(join(folder, "model.json"), { model });
		const observation = hookObservation(parsed, run.root, source === "claude" ? "claude-hook" : "codex-notify");
		if (observation) queueActivity(folder, observation, context.now());
	} catch {}
}
function attachActivity(context, root, origin, workspaceId, change) {
	try {
		const branch = currentBranch(context, root) ?? null;
		for (const folder of runs(activityFolder(context, root))) {
			const run = metadata(folder);
			if (!run || run.origin !== origin || run.workspaceId !== workspaceId || run.branch !== branch || run.changeId && run.changeId !== change.id) continue;
			writePrivateJson(join(folder, "run.json"), {
				...run,
				changeId: change.id,
				changeNumber: change.number,
				changeUrl: change.html_url
			});
		}
		startActivityUpload(context, root);
	} catch {}
}
function activityStatus(context, repository) {
	const entries = runs(activityFolder(context, repository.root)).map((folder) => ({
		folder,
		run: metadata(folder),
		state: delivery(folder),
		count: pending(folder).length
	}));
	let origin, workspaceId = repository.link?.workspaceId ?? context.env.BRAID_WORKSPACE_ID;
	try {
		origin = resolveOrigin(context, repository.link);
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
	}
	const credentials = origin ? savedCredentials(context.env, origin).find((value) => value.workspaceId === workspaceId) : void 0;
	const selected = entries.filter((item) => item.run && item.run.origin === origin && item.run.workspaceId === workspaceId);
	return {
		origin,
		workspaceId,
		expiry: credentials?.expiresAt,
		queued: selected.reduce((total, item) => total + item.count, 0),
		lastError: selected.findLast((item) => item.state.lastError)?.state.lastError,
		connected: !!context.env.BRAID_ACCESS_TOKEN || !!(credentials?.expiresAt && Date.parse(credentials.expiresAt) > context.now())
	};
}
//#endregion
//#region src/identity.ts
/** Coding tools by the executable or package they run as. */
const TOOLS = [
	{
		tool: "claude-code",
		name: /^claude$/,
		path: /@anthropic-ai\/claude-code\b/
	},
	{
		tool: "codex",
		name: /^codex(?:-[\w-]+)?$/,
		path: /@openai\/codex\b/
	},
	{
		tool: "cursor",
		name: /^cursor-agent$/,
		path: /\/cursor-agent\//
	},
	{
		tool: "gemini",
		name: /^gemini$/,
		path: /@google\/gemini-cli\b/
	},
	{
		tool: "opencode",
		name: /^opencode$/,
		path: /\bopencode-ai\b/
	},
	{
		tool: "github-copilot",
		name: /^copilot$/,
		path: /@github\/copilot\b/
	}
];
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python3?)(?:\.exe)?$/;
/** What Braid accepts as a model, a tool (`claude-code/2.4.1`) and a session id. */
const MODEL = /^[^\x00-\x1f\x7f]{1,120}$/;
const TOOL = /^[A-Za-z0-9._/@+-]{1,80}$/;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
/** A command line's tool, and the model it was told to use, from `--model X`, `--model=X` or `-m X`. */
function fromCommand(words) {
	const program = words.findIndex((word, index) => index > 0 || !INTERPRETERS.test(basename(word)));
	const executable = words[program] ?? "";
	const known = TOOLS.find((entry) => entry.name.test(basename(executable).replace(/\.(?:c?js|mjs|exe|cmd)$/, "")) || entry.path?.test(executable));
	if (!known) return {};
	let model;
	for (const [index, word] of words.entries()) {
		if (index <= program) continue;
		const inline = /^--model=(.+)$/.exec(word)?.[1];
		if (inline) {
			model = inline;
			break;
		}
		if ((word === "--model" || word === "-m") && words[index + 1] && !words[index + 1].startsWith("-")) {
			model = words[index + 1];
			break;
		}
	}
	return {
		tool: known.tool,
		...model ? { model: model.replace(/\[[^\]]*\]$/, "") } : {}
	};
}
/** What a tool says about itself in the environment of the commands it runs. */
function fromEnvironment(env) {
	const declared = /^([a-z][a-z0-9-]*?)_(\d+(?:-\d+)*)(?:_|$)/.exec(env.AI_AGENT ?? "");
	const claude = env.CLAUDECODE === "1" ? /\/versions\/(\d[\w.+-]*)\/?$/.exec(env.CLAUDE_CODE_EXECPATH ?? "")?.[1] : void 0;
	const tool = declared ? `${declared[1]}/${declared[2].replaceAll("-", ".")}` : env.CLAUDECODE === "1" ? `claude-code${claude ? `/${claude}` : ""}` : void 0;
	const session = env.CLAUDECODE === "1" ? env.CLAUDE_CODE_SESSION_ID : void 0;
	return {
		...tool ? { tool } : {},
		...session ? { session } : {}
	};
}
/** The command lines of this process's ancestors, nearest first, from `ps`. Windows has no `ps`, so nothing is found there. */
function ancestors(start) {
	if (!start || process.platform === "win32") return [];
	const table = spawnSync("ps", [
		"-A",
		"-o",
		"pid=,ppid=,args="
	], {
		encoding: "utf8",
		timeout: 2e3
	});
	if (table.status !== 0) return [];
	const processes = /* @__PURE__ */ new Map();
	for (const line of table.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match) processes.set(Number(match[1]), {
			parent: Number(match[2]),
			args: match[3]
		});
	}
	const chain = [];
	for (let pid = start, steps = 0; pid > 1 && steps < 16; steps++) {
		const entry = processes.get(pid);
		if (!entry) break;
		chain.push(entry.args.split(/\s+/).filter(Boolean));
		pid = entry.parent;
	}
	return chain;
}
/**
* The run braid is part of: flags first, then BRAID_* variables, then the nearest ancestor process that is a known
* coding tool. A tool's environment is inherited by every tool it starts, so it only adds its version and session
* when it names that same tool, or when no tool shows in the process tree.
*/
function resolveRun(flags, env, ancestor) {
	const hinted = fromEnvironment(env);
	const environment = !ancestor.tool || hinted.tool && toolName(hinted.tool) === toolName(ancestor.tool) ? hinted : {};
	const pick = (valid, ...values) => values.map((value) => value?.trim()).find((value) => value && valid.test(value));
	return {
		tool: pick(TOOL, flags.tool, env.BRAID_TOOL, environment.tool ?? ancestor.tool),
		model: pick(MODEL, flags.model, env.BRAID_MODEL, ancestor.model),
		session: pick(SESSION, flags.session, env.BRAID_SESSION, environment.session, ancestor.session),
		parentSession: pick(SESSION, flags.parentSession, env.BRAID_PARENT_SESSION, ancestor.parentSession),
		agentId: pick(/^[^\x00-\x1f\x7f]{1,200}$/, env.BRAID_AGENT_ID)
	};
}
/** The run for this process, looking up the process tree only when flags and BRAID_* variables leave something out. */
function detectRun(context, flags = {}) {
	const needsChain = !(flags.tool ?? context.env.BRAID_TOOL) || !(flags.model ?? context.env.BRAID_MODEL);
	return resolveRun(flags, context.env, needsChain ? ancestors(context.parentPid).map(fromCommand).find((found) => found.tool) ?? {} : {});
}
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
/** A new session id, `s_` and 26 characters: the time in milliseconds, then 80 random bits, so ids sort by when they began. */
function newSession(now) {
	let time = "";
	for (let value = now, index = 0; index < 10; index++, value = Math.floor(value / 32)) time = BASE32[value % 32] + time;
	return `s_${time}${[...randomBytes(16)].map((byte) => BASE32[byte % 32]).join("")}`;
}
//#endregion
//#region src/present.ts
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const mappedLogin = (person) => person.github || githubLogin(person.email ?? "") || githubLogin(person.name);
/** A person as braid prints them: their GitHub login when known, else their name. */
const personHandle = (value) => {
	const login = githubLogin(value);
	return login ? `@${login}` : value;
};
function personLabel(person, logins) {
	if (!person) return "";
	const login = mappedLogin(person) || (LOGIN.test(person.name) && logins?.has(person.name) ? person.name : void 0);
	return redactEmails(login ? `@${login}` : person.name);
}
/** Only a mapped login establishes an alias; display names and similar spellings do not. */
function personLogins(people, history = []) {
	const logins = new Set(history);
	for (const person of people) {
		const login = person && mappedLogin(person);
		if (login && LOGIN.test(login)) logins.add(login);
	}
	return logins;
}
/** Read author and real co-author logins throughout this revision's history, retaining only the login set. */
async function historyLogins(context, root, revision = "HEAD") {
	const logins = /* @__PURE__ */ new Set();
	for await (const commit of streamCommits(context, root, [resolveCommit(context, root, revision)])) {
		const people = [commit.author, ...(parseTrailers(commit.message).get("co-authored-by") ?? []).map(parsePerson)];
		for (const login of personLogins(people)) logins.add(login);
	}
	return logins;
}
/** An agent by its model's display name, naming the model too when the agent is known by another name, such as a bot. */
function agentLabel(agent) {
	const model = agent.model ? modelName(agent.model) : void 0;
	return model && model.toLowerCase() !== agent.name.toLowerCase() && agent.model?.toLowerCase() !== agent.name.toLowerCase() ? `${agent.name} (${model})` : agent.name;
}
/** Who wrote a commit: an agent, a person, or automation by its own name. */
const authorLabel = (provenance, logins) => provenance.kind === "bot" ? provenance.agent?.name ?? "Bot" : provenance.agent ? agentLabel(provenance.agent) : personLabel(provenance.owner, logins);
/** Whose work it was, for an agent's commit; a person's own commit needs no second name. */
const ownerLabel = (provenance, logins) => provenance.kind === "agent" ? personLabel(provenance.owner, logins) : "";
const changeLabel = (provenance) => provenance.change ? `#${provenance.change.number}` : "";
/** Provenance for each commit, reading Braid's notes for all of them in one batch. */
function provenances(context, root, commits, index = noteIndex(context, root, NOTES_REF)) {
	const notes = readNotes(context, root, NOTES_REF, commits.map((commit) => commit.id), index);
	return commits.map((commit) => provenanceOf(canonicalCredits(commit), parseNote(notes.get(commit.id) ?? "")));
}
/** Copilot CLI's official credit is an alias of its bot identity in the shared reader. Git stays untouched. */
function canonicalCredits(commit) {
	const boundary = commit.message.indexOf("\n");
	return {
		...commit,
		author: /^copilot@github\.com$/i.test(commit.author.email) ? {
			...commit.author,
			name: "copilot[bot]"
		} : commit.author,
		message: boundary < 0 ? commit.message : commit.message.slice(0, boundary) + commit.message.slice(boundary).replace(/^(Co-authored-by:[\t ]*)[^<>\r\n]*(<copilot@github\.com>)[\t ]*$/gim, "$1copilot[bot] $2")
	};
}
/**
* Whether a commit matches `braid log` and `braid agent list` filters, each a case-insensitive part of what it names:
* the agent's display name, the model's id or display name (an id such as claude-opus-5-5 also matches its display
* name), and the owner's name, login or address.
*/
function matches(provenance, filters) {
	const contains = (values, forms) => values.some((value) => value && forms.some((form) => value.toLowerCase().includes(form.toLowerCase())));
	const named = (wanted) => [wanted, modelName(wanted)];
	const { agent, owner } = provenance;
	return (!filters.agent || provenance.kind === "agent" && !!agent && contains([agent.name, agentLabel(agent)], named(filters.agent))) && (!filters.model || provenance.kind === "agent" && !!agent?.model && contains([agent.model, modelName(agent.model)], named(filters.model))) && (!filters.owner || contains([
		owner?.name,
		owner?.email,
		owner?.github ? `@${owner.github}` : void 0
	], [filters.owner]));
}
//#endregion
//#region src/commands/agent.ts
const parseModel = (value) => MODEL.test(value.trim()) ? value.trim() : fail("Name the model in at most 120 characters, such as claude-opus-5-5.");
const parseTool = (value) => TOOL.test(value) ? value : fail("Name the tool with at most 80 letters, digits and . _ / @ + - characters, such as claude-code/2.4.1.");
const parseSession = (value) => SESSION.test(value) ? value : fail("A session id has at most 80 letters, digits, _ and - characters.");
/** The post-commit hook calls `braid`; when it is not on PATH, as under `node braid.mjs`, a launcher for this file goes first on the agent's PATH. */
function launcher(context, env) {
	if (process.platform === "win32" || !context.script) return void 0;
	if ((env.PATH ?? "").split(delimiter).some((folder) => {
		try {
			accessSync(join(folder || ".", "braid"), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	})) return void 0;
	const folder = mkdtempSync(join(tmpdir(), "braid-bin-"));
	writeFileSync(join(folder, "braid"), `#!/bin/sh\nexec ${shellCommand([process.execPath, context.script])} "$@"\n`, { mode: 493 });
	env.PATH = `${folder}${delimiter}${env.PATH ?? ""}`;
	return folder;
}
async function run$1(flags, ...command) {
	if (!command.length) fail("Give the command to run after --, such as braid agent run -- claude.");
	const env = { ...this.env };
	const detected = fromCommand(command);
	const tool = flags.tool ?? detected.tool ?? env.BRAID_TOOL;
	const sameTool = !detected.tool || !env.BRAID_TOOL || toolName(env.BRAID_TOOL) === toolName(detected.tool);
	const model = flags.model ?? detected.model ?? (detected.tool === "claude-code" ? env.ANTHROPIC_MODEL : void 0) ?? (sameTool ? env.BRAID_MODEL : void 0);
	const parent = [env.BRAID_SESSION, fromEnvironment(this.env).session].find((value) => value && SESSION.test(value));
	const agentId = env.BRAID_AGENT_ID;
	const values = {
		BRAID_MODEL: model && MODEL.test(model.trim()) ? model.trim() : void 0,
		BRAID_TOOL: tool && TOOL.test(tool) ? tool : void 0,
		BRAID_SESSION: newSession(this.now()),
		BRAID_PARENT_SESSION: parent,
		BRAID_AGENT_ID: agentId
	};
	for (const [key, value] of Object.entries(values)) if (value) env[key] = value;
	else delete env[key];
	delete env.BRAID_AGENT;
	const folder = launcher(this, env);
	let activity;
	let reportingError;
	try {
		const repository = findRepository(this);
		if (repository) activity = beginActivity(this, repository, values.BRAID_SESSION, values.BRAID_MODEL, values.BRAID_TOOL);
	} catch (error) {
		reportingError = error instanceof CliError ? error.message : "Activity could not be queued. Check local Braid file permissions.";
	}
	const hooks = activity ? installActivityHooks(this, command, detected.tool) : {
		command,
		description: "start, exit and commits",
		cleanup() {}
	};
	if (activity) {
		env.BRAID_ACTIVITY_DIR = activity.folder;
		startActivityUpload(this, activity.run.root);
		note(this, `Braid · ${activity.run.origin} / ${activity.run.workspaceId} · ${model ? modelName(model) : tool ? toolName(tool) : "local agent"} · reporting ${hooks.description}${activity.run.changeNumber ? ` · ${activity.run.changeUrl ?? `${activity.run.origin}/pull/${activity.run.changeNumber}?workspace=${activity.run.workspaceId}`}` : ""}${activity.error ? ` · ${activity.error} Work continues; events are queued.` : ""}`);
	} else {
		delete env.BRAID_ACTIVITY_DIR;
		note(this, `Braid · activity disconnected · ${reportingError ?? "Run braid login, then braid init to report activity."} Work continues.`);
	}
	const child = spawn(hooks.command[0], hooks.command.slice(1), {
		cwd: this.cwd,
		stdio: "inherit",
		env
	});
	const handlers = [
		"SIGINT",
		"SIGTERM",
		"SIGHUP"
	].map((signal) => [signal, () => {
		if (signal !== "SIGINT") child.kill(signal);
	}]);
	for (const [signal, handler] of handlers) this.signals.on(signal, handler);
	let exitCode = 1;
	try {
		this.process.exitCode = exitCode = await new Promise((resolve, reject) => {
			child.once("error", (error) => reject(error.code === "ENOENT" ? new CliError(`${command[0]} was not found on PATH.`) : error));
			child.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants$1.signals[signal] ?? 0 : 0)));
		});
	} finally {
		if (activity) try {
			finishActivity(activity.folder, exitCode, this.now());
			startActivityUpload(this, activity.run.root);
		} catch {}
		hooks.cleanup();
		for (const [signal, handler] of handlers) this.signals.off(signal, handler);
		if (folder) rmSync(folder, {
			recursive: true,
			force: true
		});
	}
}
/** The agents in this repository's recent history, by model and owner, and Braid's roster for it when Braid has one. */
async function list$1(flags) {
	const repository = openRepository(this), { root } = repository;
	const commits = [];
	if (hasCommit(this, root, "HEAD")) for await (const commit of streamCommits(this, root, [
		"-n",
		String(flags.limit),
		"HEAD"
	])) commits.push(commit);
	const seen = /* @__PURE__ */ new Map();
	for (const provenance of provenances(this, root, commits)) {
		if (provenance.kind !== "agent" || !provenance.agent) continue;
		const name = agentLabel(provenance.agent), owner = personLabel(provenance.owner), key = `${name}\0${owner}`;
		const entry = seen.get(key) ?? {
			name,
			owner,
			models: /* @__PURE__ */ new Map(),
			tools: /* @__PURE__ */ new Set(),
			sessions: /* @__PURE__ */ new Set(),
			commits: 0,
			last: provenance.at
		};
		entry.commits++;
		const model = provenance.agent.model, display = model && modelName(model);
		if (model && display && (!entry.models.has(display) || model !== display)) entry.models.set(display, model);
		if (provenance.agent.tool) entry.tools.add(provenance.agent.tool);
		if (provenance.agent.session) entry.sessions.add(provenance.agent.session);
		if (provenance.at > entry.last) entry.last = provenance.at;
		seen.set(key, entry);
	}
	const local = [...seen.values()].sort((a, b) => b.last.localeCompare(a.last));
	for (const entry of local) {
		const versioned = new Set([...entry.tools].filter((tool) => tool !== toolBase(tool)).map(toolBase));
		for (const base of versioned) entry.tools.delete(base);
	}
	let roster;
	const braid = maybeConnect(this, repository);
	if (braid) try {
		roster = await braid.get("/api/agents", agentRecords);
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
	}
	const origin = braid?.origin ?? "";
	if (flags.json) {
		print(this, JSON.stringify({
			local: local.map((entry) => ({
				...entry,
				models: [...entry.models.values()],
				tools: [...entry.tools],
				sessions: entry.sessions.size
			})),
			braid: roster ?? null
		}, null, 2));
		return;
	}
	const paint = colours(this), now = this.now();
	if (!local.length && !roster?.length) {
		print(this, `No agents in the last ${flags.limit} commits.`);
		return;
	}
	if (local.length) {
		const rows = [[
			"Agent",
			"Owner",
			"Commits",
			"Runs",
			"Last",
			"Tools"
		], ...local.map((entry) => [
			entry.name,
			entry.owner,
			String(entry.commits),
			entry.sessions.size ? String(entry.sessions.size) : "",
			age(entry.last, now),
			[...entry.tools].join(", ")
		])];
		for (const row of columns(rows, (cell, column, index) => index === 0 ? paint.dim(cell) : column === 0 ? paint.cyan(cell) : column === 1 ? paint.dim(cell) : cell)) print(this, row);
	}
	if (roster?.length) {
		print(this);
		print(this, paint.bold(`On ${origin}`));
		const rows = [[
			"Agent",
			"Owner",
			"Landed",
			"Sent back",
			"Reverted",
			"Lines alive",
			"Models"
		], ...roster.map((record) => [
			`${record.name}${record.simulated ? " (simulated)" : ""}`,
			personLabel(record.owner),
			String(record.changes.landed),
			String(record.changes.sentBack),
			String(record.changes.reverted),
			record.lines.added ? `${record.lines.alive}/${record.lines.added}` : "",
			record.models.join(", ")
		])];
		for (const row of columns(rows, (cell, column, index) => index === 0 ? paint.dim(cell) : column === 0 ? paint.cyan(cell) : cell)) print(this, row);
	}
}
const agentRoutes = buildRouteMap({
	routes: {
		run: buildCommand({
			func: run$1,
			parameters: {
				flags: {
					model: {
						kind: "parsed",
						parse: parseModel,
						brief: "Model id, such as claude-opus-5-5; read from the command's own --model when not given",
						placeholder: "id",
						optional: true
					},
					tool: {
						kind: "parsed",
						parse: parseTool,
						brief: "Tool and version, such as claude-code/2.4.1; detected from the command when not given",
						placeholder: "name",
						optional: true
					}
				},
				positional: {
					kind: "array",
					parameter: {
						brief: "The coding tool to run and its arguments, after --",
						parse: String,
						placeholder: "command"
					}
				}
			},
			docs: {
				brief: "Run a coding tool as an agent",
				customUsage: [{
					input: "[--model id] [--tool name] -- <command...>",
					brief: "For example: braid agent run -- claude --model claude-opus-5-5"
				}],
				fullDescription: "Runs the command with its model, tool and a new session. Claude Code hooks report tool activity; Codex notify reports turn completion. Other tools report start, exit and commits only. Events queue locally while offline; braid status shows the backlog. With the post-commit hook from braid init, each commit carries the run in a refs/notes/braid note. Exits with the command's exit code."
			}
		}),
		list: buildCommand({
			func: list$1,
			parameters: {
				flags: {
					json: {
						kind: "boolean",
						brief: "Print JSON",
						optional: true
					},
					limit: {
						kind: "parsed",
						parse: numberParser,
						brief: "How many recent commits to read",
						placeholder: "n",
						default: "2000"
					}
				},
				aliases: { n: "limit" }
			},
			docs: { brief: "List the agents in recent commits, and on Braid" }
		})
	},
	docs: { brief: "Run coding tools as agents, and see which ones wrote this repository" }
});
//#endregion
//#region src/commands/blame.ts
function uncommitted$1(context, root) {
	const ident = gitTry(context, ["var", "GIT_AUTHOR_IDENT"], { cwd: root });
	const person = ident.status === 0 ? parsePerson(ident.stdout.toString("utf8").replace(/\s+\d+\s+[+-]\d{4}\s*$/, "")) : { name: "You" };
	return {
		commit: "0".repeat(40),
		at: new Date(context.now()).toISOString(),
		subject: "Not committed yet",
		kind: "human",
		owner: person,
		confidence: "inferred"
	};
}
function blameFile(context, root, path, revision) {
	const prefix = gitText(context, ["rev-parse", "--show-prefix"]);
	const file = posix.normalize(posix.join(prefix, path.replaceAll("\\", "/")));
	if (file.startsWith("../") || file === ".." || posix.isAbsolute(file) || file === ".") fail(`${path} is not a file in this repository.`);
	const lines = blame(context, root, file, revision ? resolveCommit(context, root, revision) : void 0);
	const facts = readCommits(context, root, [...new Set(lines.map((line) => line.commit))]);
	const known = new Map(provenances(context, root, [...facts.values()]).map((provenance) => [provenance.commit, fileProvenance(provenance, file)]));
	let pending;
	const provenanceOf = (id) => ZERO.test(id) ? pending ??= uncommitted$1(context, root) : known.get(id) ?? fail(`Git did not return commit ${id}.`);
	const ranges = [];
	lines.forEach((line, index) => {
		const provenance = provenanceOf(line.commit), last = ranges.at(-1);
		if (last?.provenance === provenance) last.lines++;
		else ranges.push({
			start: index + 1,
			lines: 1,
			provenance
		});
	});
	return {
		blame: {
			path: file,
			ref: revision ?? "HEAD",
			lines: lines.length,
			ranges
		},
		text: lines.map((line) => line.text)
	};
}
async function upgrade(braid, result) {
	const ids = [...new Set(result.ranges.map((range) => range.provenance.commit))].filter((id) => /^[a-f0-9]{40}$/.test(id) && !ZERO.test(id));
	const witnessed = /* @__PURE__ */ new Map();
	try {
		for (let index = 0; index < ids.length; index += 100) for (const record of await braid.get(`/api/provenance?commits=${ids.slice(index, index + 100).join(",")}`, provenanceList)) if (record.confidence === "braid") witnessed.set(record.commit, fileProvenance(record, result.path));
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
	}
	return witnessed.size ? {
		...result,
		ranges: result.ranges.map((range) => ({
			...range,
			provenance: witnessed.get(range.provenance.commit) ?? range.provenance
		}))
	} : result;
}
function blameTable(context, result, text, history) {
	const paint = colours(context), now = context.now();
	const logins = personLogins(result.ranges.map((range) => range.provenance.owner), history);
	const rows = [[
		"Lines",
		"Author",
		"Owner",
		"Pull request",
		"Age",
		"Code"
	], ...result.ranges.map((range) => [
		range.lines === 1 ? String(range.start) : `${range.start}-${range.start + range.lines - 1}`,
		ZERO.test(range.provenance.commit) ? "Not committed" : authorLabel(range.provenance, logins),
		ownerLabel(range.provenance, logins),
		changeLabel(range.provenance),
		age(range.provenance.at, now),
		redact(text[range.start - 1]?.trim() ?? "")
	])];
	fitLast(context, rows);
	return columns(rows, (cell, column, index) => {
		if (index === 0) return paint.dim(cell);
		const range = result.ranges[index - 1];
		if (column === 1) return range.provenance.kind === "agent" ? paint.cyan(cell) : ZERO.test(range.provenance.commit) ? paint.dim(cell) : cell;
		return column === 3 ? paint.yellow(cell) : column === 5 ? cell : paint.dim(cell);
	});
}
async function run(flags, path) {
	const repository = openRepository(this);
	const local = blameFile(this, repository.root, path, flags.rev);
	const braid = maybeConnect(this, repository);
	const result = braid ? await upgrade(braid, local.blame) : local.blame;
	if (flags.json) {
		print(this, JSON.stringify(result, null, 2));
		return;
	}
	const logins = await historyLogins(this, repository.root, flags.rev);
	for (const row of blameTable(this, result, local.text, logins)) print(this, row);
}
const blameCommand = buildCommand({
	func: run,
	parameters: {
		flags: {
			json: {
				kind: "boolean",
				brief: "Print the FileBlame JSON",
				optional: true
			},
			rev: {
				kind: "parsed",
				parse: String,
				brief: "Blame the file as of this revision instead of the working tree",
				placeholder: "revision",
				optional: true
			}
		},
		positional: {
			kind: "tuple",
			parameters: [{
				brief: "The file to blame",
				parse: String,
				placeholder: "path"
			}]
		}
	},
	docs: { brief: "Show which agent, person or bot wrote each line of a file" }
});
//#endregion
//#region src/collect.ts
/** Git objects pin committed content while the CLI validates a submission. */
const LIMITS = { bytes: 31998976 };
const LIMIT_MESSAGE$1 = "Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.";
/** A repository path Braid accepts in a change: relative, inside the repository, and outside .git, .braid and credential files. */
function validPath(path) {
	return path.length > 0 && path.length <= 240 && !path.startsWith("/") && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path) && !/[\uD800-\uDFFF]/u.test(path) && path.split("/").every((part) => part && part !== ".." && part !== "." && ![".git", ".braid"].includes(part.toLowerCase())) && !/(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?)(?:$|\/)/i.test(path);
}
/** File bytes as text, refusing anything that is not UTF-8 or that holds the control characters of a binary file. */
function decodeText(bytes) {
	let text;
	try {
		text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true
		}).decode(bytes);
	} catch {
		return fail("JSON submissions accept UTF-8 text. Use braid submit --push for binary files.");
	}
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail("Binary files use Git. Run braid submit --push.");
	return text;
}
/** Every file in a commit's tree with its mode, object id and size. */
function treeEntries(context, root, commit) {
	const entries = /* @__PURE__ */ new Map();
	const output = new TextDecoder("utf-8", { fatal: true }).decode(git(context, [
		"ls-tree",
		"-r",
		"-z",
		"-l",
		"--full-tree",
		commit
	], { cwd: root }));
	for (const record of output.split("\0").filter(Boolean)) {
		const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
		if (!match) fail("Git listed a tree entry braid cannot read.");
		entries.set(match[5], {
			mode: match[1],
			hash: match[3],
			size: match[4] === "-" ? 0 : Number(match[4])
		});
	}
	return entries;
}
/** The files that differ between two commits, with their new content, or null for a deletion. */
function committedFiles(context, root, base, head, secrets) {
	const before = treeEntries(context, root, base), after = treeEntries(context, root, head);
	const files = [];
	for (const path of [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])].sort()) {
		const prior = before.get(path), next = after.get(path);
		if (prior && next && prior.mode === next.mode && prior.hash === next.hash) continue;
		if ([prior, next].some((entry) => entry && !REGULAR.has(entry.mode))) fail(`${path} is a symlink or submodule; changes to those cannot be submitted.`);
		if (!validPath(path)) fail(`${path} is a protected or invalid path for a change.`);
		if ((next?.size ?? 0) > LIMITS.bytes) fail(LIMIT_MESSAGE$1);
		if (!next) {
			files.push({
				path,
				content: null
			});
			continue;
		}
		const content = decodeText(git(context, [
			"cat-file",
			"blob",
			next.hash
		], { cwd: root }));
		assertNoSecrets(content, secrets, `${path} looks like it contains a credential. Remove it from the commits before submitting.`);
		files.push({
			path,
			content,
			...next.mode !== (prior?.mode ?? "100644") ? { mode: next.mode } : {}
		});
	}
	return files;
}
/** Uncommitted changes to tracked files, and untracked files outside .braid/, which keeps Braid's own local files. */
function uncommitted(context, root) {
	return git(context, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--ignore-submodules=none"
	], { cwd: root }).toString("utf8").split("\0").filter((entry) => entry && !(entry.startsWith("?? ") && entry.slice(3).startsWith(".braid/")));
}
/**
* The change from `base` to HEAD. HEAD must descend from the base and the working tree must be clean; HEAD and the
* index are compared before and after reading, so a commit made meanwhile is caught.
*/
function collectChanges(context, root, base, secrets) {
	const state = () => `${gitText(context, [
		"rev-parse",
		"--verify",
		"HEAD"
	], { cwd: root })}\0${git(context, [
		"ls-files",
		"--stage",
		"-z"
	], { cwd: root }).toString("base64")}`;
	const dirty = uncommitted(context, root);
	if (dirty.length) fail(`Commit your work before submitting; the change is read from commits. Not committed: ${dirty.slice(0, 3).map((entry) => entry.slice(3)).join(", ")}${dirty.length > 3 ? ` and ${dirty.length - 3} more` : ""}.`);
	if (!isAncestor(context, root, base)) fail(`HEAD does not descend from the base ${base}. Rebase onto it, or run braid sync first.`);
	const before = state(), head = before.split("\0")[0];
	const files = committedFiles(context, root, base, head, secrets);
	if (state() !== before || uncommitted(context, root).length) fail("The repository changed while braid read the change. Run braid submit again when edits are finished.");
	if (!files.length) fail(`There are no committed changes since ${base.slice(0, 12)} to submit.`);
	return {
		head,
		files
	};
}
/** Validate a native Git submission one blob at a time, including binary files. */
function validatePush(context, root, base, secrets) {
	if (uncommitted(context, root).length) fail("Commit your work before submitting.");
	const head = gitText(context, [
		"rev-parse",
		"--verify",
		"HEAD"
	], { cwd: root });
	if (!isAncestor(context, root, base, head)) fail("Rebase onto the base commit before submitting.");
	const before = treeEntries(context, root, base), after = treeEntries(context, root, head);
	let changed = false;
	for (const path of /* @__PURE__ */ new Set([...before.keys(), ...after.keys()])) {
		const prior = before.get(path), next = after.get(path);
		if (prior && next && prior.mode === next.mode && prior.hash === next.hash) continue;
		changed = true;
		if (!validPath(path)) fail(`${path} is a protected or invalid path for a change.`);
		if ([prior, next].some((entry) => entry && !REGULAR.has(entry.mode))) fail(`${path} is a symlink or submodule; changes to those cannot be submitted.`);
		if (!next) continue;
		if (next.size > LIMITS.bytes) fail(LIMIT_MESSAGE$1);
		assertNoSecrets(git(context, [
			"cat-file",
			"blob",
			next.hash
		], { cwd: root }).toString("utf8"), secrets, `${path} looks like it contains a credential. Remove it from the commits before submitting.`);
	}
	if (!changed) fail("There are no committed changes to submit.");
	if (gitText(context, [
		"rev-parse",
		"--verify",
		"HEAD"
	], { cwd: root }) !== head || uncommitted(context, root).length) fail("The repository changed while braid read the change. Run braid submit again when edits are finished.");
}
/** Agent-reported test results from a JSON file of at most 128 KB, as `--tests` names it. */
function readTests(context, path) {
	let bytes;
	try {
		bytes = readRegularFile(resolve(context.cwd, path), 128e3);
	} catch {
		return fail(`Cannot read the tests file ${path}.`);
	}
	if (!bytes) fail("The tests file must be a regular file of at most 128 KB.");
	const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(void 0, "The tests file is not valid JSON."), testReports), bytes.toString("utf8"));
	return parsed.success ? parsed.output : fail(parsed.issues[0].message);
}
//#endregion
//#region src/checkout.ts
/** An existing sparse or partial checkout must never silently become an agent's whole repository. */
function assertFullCheckout(context, root) {
	const config = strict(context, [
		"config",
		"--local",
		"--list",
		"--null"
	], { cwd: root }).toString("utf8");
	if (/(?:^|\0)core\.sparsecheckout\n(?:true|1|yes|on)(?:\0|$)/i.test(config) || /(?:^|\0)(?:extensions\.partialclone|remote\.[^\n]+\.promisor)\n/i.test(config) || strict(context, [
		"ls-files",
		"-t",
		"-z"
	], { cwd: root }).toString("utf8").split("\0").some((entry) => entry.startsWith("S "))) fail("Agents need a full repository checkout. Disable sparse checkout and materialize all files, or use braid task start with --dir NEW_DIRECTORY.");
}
/** The checkout at `dir`, which must be the real root of a full Git checkout. */
function checkoutRoot(context, dir) {
	const root = realpathSync(realDirectory(resolve(context.cwd, dir)));
	const entry = lstatSync(join(root, ".git"));
	if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) fail("Invalid Git checkout metadata.");
	if (realpathSync(strict(context, ["rev-parse", "--show-toplevel"], { cwd: root }).toString("utf8").trim()) !== root) fail("Run this from the root of the task checkout, or name it with --dir.");
	assertFullCheckout(context, root);
	return root;
}
/** HEAD must keep at least one of the given task bases in its history. */
function pinnedBase(context, root, ...commits) {
	const bases = commits.filter((commit) => commit !== void 0);
	if (!bases.length || !bases.some((commit) => isAncestor(context, root, commit))) fail("HEAD must descend from the task's base commit. Keep the task's history before submitting.");
}
const LIMIT_MESSAGE = "Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.";
/** A repository path as a file inside the checkout, refusing symlinks and special files on the way there. */
function checkedFile(root, path, mode = "100644", allowMissing = false) {
	const parts = path.split("/"), full = resolve(root, path), fromRoot = relative(root, full);
	if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || parts.some((part) => !part || part === "." || part === "..") || path.includes("\\")) fail("Repository paths must stay inside the checkout.");
	let current = root;
	for (const [index, part] of parts.entries()) {
		current = join(current, part);
		let stat;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (allowMissing && error.code === "ENOENT") return null;
			return fail("Deleted or missing files cannot be submitted.");
		}
		const leaf = index === parts.length - 1;
		if (stat.isSymbolicLink() && !(leaf && mode === "120000")) fail("Symlinks cannot be submitted or followed.");
		if (!(!leaf || mode === "160000" ? stat.isDirectory() : mode === "120000" ? stat.isSymbolicLink() : stat.isFile())) fail("Only regular files can be submitted; changes to symlinks, submodules and special files are unsupported.");
	}
	return full;
}
/** A file's bytes and its Git object id, hashed as it is read, refusing a file that changes meanwhile. */
function readBlob(path, algorithm) {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = fstatSync(fd);
		if (!before.isFile()) fail("Only regular files can be submitted.");
		const hash = createHash(algorithm).update(`blob ${before.size}\0`), chunk = Buffer.alloc(65536), kept = [];
		let size = 0, count;
		while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
			hash.update(chunk.subarray(0, count));
			if (size + count <= LIMITS.bytes) kept.push(Buffer.from(chunk.subarray(0, count)));
			size += count;
		}
		const after = fstatSync(fd);
		if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("A file changed while braid read the proposal. Retry when edits are finished.");
		return {
			hash: hash.digest("hex"),
			size,
			bytes: size <= LIMITS.bytes ? Buffer.concat(kept) : null
		};
	} finally {
		closeSync(fd);
	}
}
/** Whether a symlink or submodule the base has is still exactly as it was, so it can be left out of the proposal. */
function unchangedSpecialEntry(context, root, path, prior, staged, algorithm) {
	if (!prior || !staged || prior.mode !== staged.mode || prior.hash !== staged.hash) return false;
	const full = checkedFile(root, path, prior.mode);
	if (prior.mode === "120000") {
		const target = readlinkSync(full, { encoding: "buffer" });
		return createHash(algorithm).update(`blob ${target.length}\0`).update(target).digest("hex") === prior.hash;
	}
	if (prior.mode === "160000") {
		if (!existsSync(join(full, ".git"))) return readdirSync(full).length === 0;
		return strict(context, [
			"rev-parse",
			"--verify",
			"HEAD"
		], { cwd: full }).toString("utf8").trim() === prior.hash && strict(context, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--ignore-submodules=none"
		], { cwd: full }).length === 0;
	}
	return false;
}
/** Staged, unstaged and untracked edits against the base, read from the working tree without Git's filters. */
function workingFiles(context, root, base, index, secrets) {
	const staged = /* @__PURE__ */ new Map();
	for (const entry of index) {
		const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
		if (!match || match[3] !== "0") fail("Resolve the Git index before submitting.");
		staged.set(match[4], {
			mode: match[1],
			hash: match[2]
		});
	}
	const before = treeEntries(context, root, base);
	const untracked = strict(context, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z"
	], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
	const files = [], algorithm = base.length === 64 ? "sha256" : "sha1";
	for (const path of [.../* @__PURE__ */ new Set([
		...before.keys(),
		...staged.keys(),
		...untracked
	])].sort()) {
		const prior = before.get(path), entry = staged.get(path);
		if ([prior, entry].some((item) => item && !REGULAR.has(item.mode))) {
			if (unchangedSpecialEntry(context, root, path, prior, entry, algorithm)) continue;
			fail("Symlinks and submodules cannot be submitted.");
		}
		const full = checkedFile(root, path, "100644", true);
		if (!full) {
			if (prior) {
				if (!validPath(path)) fail(`${path} is a protected or invalid path for a proposal.`);
				files.push({
					path,
					content: null
				});
			}
			continue;
		}
		const blob = readBlob(full, algorithm);
		const mode = lstatSync(full).mode & 73 ? "100755" : "100644";
		checkedFile(root, path);
		if (blob.hash === prior?.hash && mode === prior?.mode) continue;
		if (!validPath(path)) fail(`${path} is a protected or invalid path for a proposal.`);
		if (blob.size > LIMITS.bytes) fail(LIMIT_MESSAGE);
		const content = decodeText(blob.bytes);
		assertNoSecrets(content, secrets, `${path} looks like it contains a credential. Remove it before submitting.`);
		files.push({
			path,
			content,
			...mode !== (prior?.mode ?? "100644") ? { mode } : {}
		});
	}
	return files;
}
/**
* The complete proposal from the task's base. Checkouts made by `braid task start` submit committed work only, so
* HEAD must be clean and the proposal is HEAD's tree; older checkouts submit their working tree. Either way, a change
* to HEAD, the index or (for committed work) the working tree while reading is refused.
*/
function collectProposal(context, root, base, secrets, committed) {
	pinnedBase(context, root, base);
	const state = () => ({
		head: strict(context, [
			"rev-parse",
			"--verify",
			"HEAD"
		], { cwd: root }).toString("utf8").trim(),
		index: strict(context, [
			"ls-files",
			"--stage",
			"-z"
		], { cwd: root }).toString("utf8"),
		dirty: committed && strictGit(context, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--ignore-submodules=none"
		], { cwd: root }).stdout.length > 0
	});
	const before = state();
	if (before.dirty) fail("Commit the work you want reviewed before submitting. Keep unrelated files out of this checkout.");
	const files = committed ? committedFiles(context, root, base, before.head, secrets) : workingFiles(context, root, base, before.index.split("\0").filter(Boolean), secrets);
	pinnedBase(context, root, base);
	const after = state();
	if (after.head !== before.head || after.index !== before.index || after.dirty) fail("The checkout changed while braid read the proposal. Retry when edits are finished.");
	if (!files.length) fail("There are no changed files to submit.");
	return files;
}
//#endregion
//#region src/change.ts
/** A change that will not move again: it landed or was closed. */
const finished = (status) => status === "landed" || status === "closed";
/** A change that waits on someone: it landed, was closed, came back to its author or needs a person. */
const settled = (status) => finished(status) || status === "revise" || status === "attention";
/** The last lines of a command's output, indented under it. */
function tail(output) {
	const lines = output.slice(-4e3).trimEnd().split("\n").slice(-40);
	return lines.some((line) => line.trim()) ? `\n${lines.map((line) => `  ${line}`).join("\n")}` : "";
}
/** A thread remains actionable until a person resolves it, even after its line becomes outdated. */
function describeComments(comments) {
	const roots = new Set(comments.filter((comment) => !comment.inReplyTo && !comment.resolved).map((comment) => comment.id));
	return comments.filter((comment) => roots.has(comment.inReplyTo ?? comment.id)).map((comment) => {
		const anchor = comment.anchor, owner = comment.author.owner;
		const by = `${comment.author.kind === "agent" ? comment.author.name : personHandle(comment.author.name)}${comment.author.kind === "agent" && owner ? ` for ${personLabel(owner)}` : ""}`;
		return `${comment.inReplyTo ? `Reply to ${comment.inReplyTo}` : `Comment ${comment.id}`}${anchor ? ` at ${anchor.path}:${anchor.position ?? anchor.line} (${anchor.side}${anchor.outdated ? ", Outdated" : ""}; revision ${anchor.revision})` : ""} by ${by}:\n${comment.body}`;
	}).join("\n\n");
}
/**
* Everything that sent a change back, in terms an agent can act on: failing commands with the end of their output,
* broken instructions, conflicts and reviews. Text from Braid reaches the terminal without escape sequences and
* with anything shaped like a credential replaced.
*/
function describeChange(change, secrets = []) {
	const current = (item) => item.revision === change.revision;
	const failing = change.evidence.filter((item) => item.kind === "command" && current(item) && item.exitCode !== 0);
	const state = change.status === "landed" ? "merged" : change.status === "revise" ? "changes requested" : change.status === "attention" ? "review required" : change.status;
	const lines = [`Pull request #${change.number} · ${change.title} · ${state}${change.closeReason ? ` (${change.closeReason})` : ""} · revision ${change.revision}`];
	if (change.html_url) lines.push(change.html_url);
	if (change.next) lines.push(`Next: ${change.next}`);
	if (change.dependsOn?.length) lines.push(`Depends on ${change.dependsOn.map((item) => `#${item.number}`).join(", ")}`);
	if (change.outdated?.length && !change.next?.includes("changed since this was built")) lines.push(`${change.outdated.map((item) => `#${item.number}`).join(", ")} changed since this was built`);
	if (change.requiredBy?.length) lines.push(`Required by ${change.requiredBy.map((item) => `#${item.number}`).join(", ")}`);
	const comments = describeComments(change.comments);
	if (comments) lines.push(`Unresolved review comments:\n${comments}`);
	for (const conflict of change.conflicts) lines.push(`Conflict (${conflict.kind}) in ${conflict.path}${conflict.regions?.length ? ` at line ${conflict.regions[0].baseStart + 1}` : ""}`);
	for (const item of failing) lines.push(`Failed${item.source === "braid" ? " in Braid" : ""}: ${item.command} (exit ${item.exitCode})${tail(item.output)}`);
	for (const check of change.checks.filter((check) => current(check) && check.status === "failed" && !failing.some((item) => item.command === check.label))) lines.push(`Failed check (${check.source}): ${check.label}\n${check.detail}`);
	for (const guard of change.guards) lines.push(guard.kind === "instructions" ? `Instruction broken in ${guard.path}: ${guard.detail}` : `Guard: ${guard.detail}`);
	for (const review of change.reviews.filter((review) => current(review) && review.verdict !== "approve")) lines.push(`Review (${review.reviewer}): ${review.verdict}: ${review.summary}${review.findings.map((finding) => `\n  ${finding.path ?? ""}${finding.line ? `:${finding.line}` : ""} ${finding.message}`).join("")}`);
	if (change.overlaps.length) lines.push(`Also active on the same files: ${change.overlaps.map((overlap) => `#${overlap.number}`).join(", ")}`);
	if (change.landedCommit) lines.push(`Merged as ${change.landedCommit}.`);
	return redact(plain(lines.join("\n")), secrets);
}
async function poll(context, timeout, check) {
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) fail("Use --timeout with a whole number of seconds from 1 to 86400.");
	const deadline = context.now() + timeout * 1e3, late = () => context.now() >= deadline;
	for (let delay = 5e3; !await check(late); delay = Math.min(3e4, delay * 1.5)) await context.sleep(Math.min(delay, Math.max(0, deadline - context.now())));
}
/** This CLI's command line for `args`, run the way braid itself was started, quoted to paste. */
const command = (context, ...args) => shellCommand([...context.self, ...args]);
/** The arguments that point a task command at its checkout, needed only when it is not the current directory. */
const checkoutArgs = (context, root) => {
	try {
		return realpathSync(context.cwd) === root ? [] : ["--dir", root];
	} catch {
		return ["--dir", root];
	}
};
/**
* What to do next, ending with the exact command. A change that came back is fixed and resubmitted, with proof when
* the repository has a proof file; one that needs a person stops the agent; one still moving is waited for. Nothing
* follows a landed or closed change. A task's result is resubmitted and waited for as a task, and brought up to date
* with `task update` rather than `sync`.
*/
function nextStep(context, change, { root, origin, task = false }) {
	const scoped = (...args) => task ? command(context, "task", ...args, ...checkoutArgs(context, root)) : command(context, ...args);
	if (change.outdated?.length && !change.conflicts.length) return `\nRestack this pull request:\n  ${command(context, "restack", String(change.number))}`;
	if (change.status === "revise") {
		const resubmit = scoped("submit", ...existsSync(join(root, ".braid", "proof.json")) ? ["--proof"] : []);
		if (change.outdated?.length && change.conflicts.length) return `\nResolve the conflicts with the updated prerequisites, commit, then resubmit:\n  ${resubmit}`;
		if (!change.conflicts.length) return `\nFix exactly what is listed above, commit, then resubmit:\n  ${resubmit}`;
		return task ? `\nFetch main, merge it and resolve the conflicts, fix anything else listed, commit, then resubmit:\n  ${scoped("update")}\n  ${resubmit}` : `\nFetch main, rebase onto it and resolve the conflicts, fix anything else listed, commit, then resubmit:\n  ${scoped("sync")}\n  ${resubmit}`;
	}
	if (change.status === "attention") return `\nA person must decide. Ask the owner to open pull request #${change.number}${change.html_url ? `: ${change.html_url}` : ` in this repository at ${origin}`}.`;
	if (finished(change.status)) return "";
	return `\nNext, wait until it merges or needs changes:\n  ${scoped("wait")}`;
}
//#endregion
//#region src/commands/login.ts
const url = {
	kind: "parsed",
	parse: normalizeOrigin,
	brief: "Braid address, such as https://braid.example",
	placeholder: "url",
	optional: true
};
const AGENT = "Braid CLI";
const day = (at) => new Date(at).toISOString().slice(0, 10);
/** Saves an approval with owner-only permissions where braid.mjs keeps its own. Work access is required. */
function keep(context, origin, approved, wanted) {
	if (approved.scope !== "work") fail(`The owner approved ${approved.scope} access, and braid needs work access to submit changes. Run braid login again and approve it as asked.`);
	if (Date.parse(approved.expiresAt) <= context.now()) fail("The approval had already expired. Run braid login again.");
	saveCredentials(context.env, {
		origin,
		accessToken: approved.accessToken,
		workspaceId: approved.workspaceId,
		expiresAt: approved.expiresAt
	});
	if (wanted && approved.workspaceId !== "*" && approved.workspaceId !== wanted) fail(`The owner approved repository ${approved.workspaceId}, but ${wanted} is required. That approval was saved; run braid login again and choose ${wanted}.`);
	return approved;
}
async function deviceLogin(context, origin, wanted) {
	const request = await answer(await send(context, `${origin}/api/agent/requests`, {
		method: "POST",
		body: {
			name: AGENT,
			scope: "work"
		}
	}), deviceRequest, { path: "/api/agent/requests" });
	const page = new URL(request.verificationUri);
	if (page.origin !== origin || page.username || page.password || page.href.includes(request.deviceCode) || request.interval > request.expiresIn) fail("Braid returned sign-in details braid will not use.");
	print(context, `Approve this connection in Braid: ${page.href}\nCode: ${request.userCode}\nWaiting for approval…`);
	const deadline = context.now() + request.expiresIn * 1e3;
	let interval = request.interval * 1e3, delay = interval;
	while (context.now() < deadline) {
		await context.sleep(Math.min(delay, deadline - context.now()));
		if (context.now() >= deadline) break;
		const poll = await send(context, `${origin}/api/agent/token`, {
			method: "POST",
			body: { deviceCode: request.deviceCode },
			timeout: Math.max(1, Math.min(3e4, deadline - context.now()))
		});
		if (poll.status === 410) fail("The request expired or was denied. Run braid login to try again.");
		if (poll.status === 202 || poll.status === 429) {
			if (poll.status === 429) interval += 5e3;
			delay = Math.max(interval, retryAfter(poll.headers.get("retry-after"), context.now()));
			await poll.body?.cancel();
			continue;
		}
		return keep(context, origin, await answer(poll, grant, { path: "/api/agent/token" }), wanted);
	}
	return fail("The request expired before anyone approved it. Run braid login to try again.");
}
/** The GitHub CLI's token for github.com, or undefined when gh is missing or signed out. It goes once to Braid and is never saved. */
function githubCliToken(env) {
	try {
		const token = execFileSync("gh", [
			"auth",
			"token",
			"--hostname",
			"github.com"
		], {
			encoding: "utf8",
			env,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 15e3
		}).trim();
		return /^[\x21-\x7e]{20,255}$/.test(token) ? token : void 0;
	} catch {
		return;
	}
}
function checkoutTarget(context) {
	const root = strictGit(context, ["rev-parse", "--show-toplevel"]);
	if (root.status !== 0) return void 0;
	const path = root.stdout.toString().trim();
	const origin = strictGit(context, [
		"remote",
		"get-url",
		"origin"
	], { cwd: path }).stdout.toString().trim();
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
	const name = (match?.[2] ?? basename(path)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 46);
	return {
		name: /^[a-z][a-z0-9-]+$/.test(name) ? name : `r-${name || "repository"}`,
		...match ? { github: {
			owner: match[1],
			repo: match[2]
		} } : {}
	};
}
const naming = ({ workspace, repository, checkout }) => ({
	...checkout ? { checkout } : {},
	...workspace ? { workspaceId: workspace } : {},
	...repository ? { repository } : {}
});
/** A connection for the person's own proof. Without one repository to connect, Braid's answer names the choices. */
async function selfLogin(context, origin, response, path, wanted) {
	if (response.status === 409) {
		const choice = /* @__PURE__ */ safeParse(repositoryChoice, await response.json().catch(() => void 0));
		fail(choice.success ? `${choice.output.error}${choice.output.repositories.length ? ` Repositories: ${choice.output.repositories.join(", ")}. Run braid login again with --repository OWNER/REPO.` : ""}` : "Braid needs a repository to connect.");
	}
	const approved = await answer(response, selfGrant, { path });
	keep(context, origin, approved, wanted.workspace);
	if (approved.initialization) {
		const head = strictGit(context, [
			"rev-parse",
			"--verify",
			"HEAD^{commit}"
		]);
		if (head.status === 0) strict(context, [
			"push",
			"--porcelain",
			"--force-with-lease=refs/heads/main:",
			"--",
			`${origin}/git/${approved.workspaceId}.git`,
			`${head.stdout.toString().trim()}:refs/heads/main`
		], { token: approved.initialization.accessToken });
	}
	print(context, `${approved.created ? "Created private repository" : "Connected to"} ${origin}/${approved.repository}.`);
	return approved;
}
/**
* Signs braid in for the person, and signs them up when they are new to Braid: the GitHub CLI's account when gh is
* signed in; otherwise asks for email. Browser approval is available only through an explicit --link.
*/
async function agentLogin(context, origin, wanted = {}, link = false) {
	if (!wanted.workspace && !wanted.checkout) wanted = {
		...wanted,
		checkout: checkoutTarget(context)
	};
	if (!link) {
		const token = githubCliToken(context.env);
		if (token) {
			const response = await send(context, `${origin}/api/agent/github`, {
				method: "POST",
				body: {
					token,
					name: AGENT,
					scope: "work",
					...naming(wanted)
				}
			});
			if (response.status === 201 || response.status === 409) return selfLogin(context, origin, response, "/api/agent/github", wanted);
			const reason = /* @__PURE__ */ safeParse(errorBody, await response.json().catch(() => void 0));
			fail(`Braid did not connect with GitHub: ${reason.success ? reason.output.error : `HTTP ${response.status}`}`);
		} else fail("The GitHub CLI is not signed in here. Ask the person for their email address and run braid login --email ADDRESS.");
	}
	return deviceLogin(context, origin, wanted.workspace);
}
async function emailLogin(context, origin, email, code, wanted) {
	if (!wanted.workspace && !wanted.checkout) wanted = {
		...wanted,
		checkout: checkoutTarget(context)
	};
	if (code === void 0) {
		const started = await answer(await send(context, `${origin}/api/agent/email/start`, {
			method: "POST",
			body: {
				email,
				scope: "work"
			}
		}), emailStarted, { path: "/api/agent/email/start" });
		saveEmailFlow(context.env, email, {
			origin,
			...started
		});
		print(context, `Braid emailed the person a code. Ask them for it, then run: braid login --url ${origin} --email ADDRESS --code CODE`);
		return;
	}
	const flow = readEmailFlow(context.env, origin, email) ?? fail("No code is waiting for this address. Run braid login --email ADDRESS first.");
	if (Date.parse(flow.expiresAt) <= context.now()) fail("The code for this address expired. Run braid login --email ADDRESS for a new one.");
	const response = await send(context, `${origin}/api/agent/email/verify`, {
		method: "POST",
		body: {
			flowId: flow.flowId,
			code,
			name: AGENT,
			...naming(wanted)
		}
	});
	if (response.status === 401) fail("That code is invalid or expired. Check it with the person, or run braid login --email ADDRESS for a new one.");
	const approved = await selfLogin(context, origin, response, "/api/agent/email/verify", wanted);
	removeEmailFlow(context.env, origin, email);
	return approved;
}
async function login(flags) {
	const here = findRepository(this);
	const origin = normalizeOrigin(flags.url ?? this.env.BRAID_URL ?? here?.link?.url ?? fail("Give your Braid address: braid login --url https://braid.example"));
	if (flags.code !== void 0 && flags.email === void 0) fail("--code goes with the --email the code was sent to.");
	if (flags.link && flags.email !== void 0) fail("Choose --email or --link, not both.");
	if (flags.repository !== void 0 && flags.workspace !== void 0) fail("Choose --workspace or --repository, not both.");
	if (flags.repository !== void 0 && !/^[^/\s]+\/[^/\s]+$/.test(flags.repository)) fail("Name the repository as OWNER/REPO.");
	const wanted = {
		workspace: flags.workspace ?? (flags.repository ? void 0 : here?.link?.workspaceId),
		repository: flags.repository
	};
	const approved = flags.email !== void 0 ? await emailLogin(this, origin, flags.email, flags.code, wanted) : await agentLogin(this, origin, wanted, flags.link);
	if (!approved) return;
	if (here) startActivityUpload(this, here.root);
	print(this, `Signed in to ${origin} for ${approved.workspaceId === "*" ? "your account" : `repository ${approved.workspaceId}`} until ${day(approved.expiresAt)}.${here && !here.link ? " Run braid init to link this repository." : ""}`);
}
async function logout(flags) {
	const origin = resolveOrigin(this, findRepository(this)?.link, flags.url);
	const removed = removeCredentials(this.env, origin);
	print(this, removed ? `Signed out of ${origin}. The connection stays valid until it expires; revoke it in Braid's settings to end it now.` : `Not signed in to ${origin}.`);
	if (this.env.BRAID_ACCESS_TOKEN) print(this, "BRAID_ACCESS_TOKEN is still set in this environment.");
}
async function whoami(flags) {
	const link = findRepository(this)?.link;
	const named = flags.url ?? this.env.BRAID_URL ?? link?.url;
	const origin = named ? normalizeOrigin(named) : void 0;
	const approvals = this.env.BRAID_ACCESS_TOKEN && origin ? [loadCredentials(this, origin, link?.workspaceId)] : savedCredentials(this.env, origin);
	if (!approvals.length) fail(`Not signed in${origin ? ` to ${origin}` : ""}. Run braid login --url https://your-braid.example.`);
	const paint = colours(this);
	const rows = [[
		"Braid",
		"Repository",
		"Connection",
		"Approved by",
		"Until"
	]];
	for (const credentials of approvals) {
		const expired = !!credentials.expiresAt && Date.parse(credentials.expiresAt) <= this.now();
		let agent = expired ? "expired" : "", owner = "";
		if (!expired) try {
			const braid = new Braid(this, credentials), person = await braid.owner();
			agent = (await braid.session()).agent.name;
			owner = person?.name ?? "";
		} catch (error) {
			if (!(error instanceof CliError)) throw error;
			agent = error instanceof ApiError ? "not accepted" : "unreachable";
		}
		rows.push([
			credentials.origin,
			credentials.workspaceId,
			agent,
			owner,
			credentials.expiresAt ? day(credentials.expiresAt) : "from environment"
		]);
	}
	for (const row of columns(rows, (cell, _column, index) => index === 0 ? paint.dim(cell) : cell)) print(this, row);
}
const text$2 = (brief, placeholder) => ({
	kind: "parsed",
	parse: String,
	brief,
	placeholder,
	optional: true
});
const loginCommand = buildCommand({
	func: login,
	parameters: { flags: {
		url,
		workspace: text$2("Require this repository id", "id"),
		repository: text$2("Connect this repository, by its OWNER/REPO address", "owner/repo"),
		email: text$2("Sign in with a code Braid emails to this address; run again with --code", "address"),
		code: text$2("The code from the email, as the person reads it out", "code"),
		link: {
			kind: "boolean",
			brief: "Skip the GitHub CLI and show a link for the owner to approve",
			optional: true
		}
	} },
	docs: {
		brief: "Sign in for the person, and sign them up when they are new",
		fullDescription: "Signs in with the GitHub CLI's account when gh is signed in, with a code Braid emails the person (--email, then --code), or with a page and code the person approves. The approval is saved with owner-only permissions where braid.mjs keeps its own, so both tools share it. Tokens never appear in arguments or output; BRAID_ACCESS_TOKEN and BRAID_WORKSPACE_ID override the saved approval."
	}
});
const logoutCommand = buildCommand({
	func: logout,
	parameters: { flags: { url } },
	docs: { brief: "Forget the saved approval for a Braid" }
});
const whoamiCommand = buildCommand({
	func: whoami,
	parameters: { flags: { url } },
	docs: { brief: "Show who braid acts as, and for which repository" }
});
//#endregion
//#region src/proof.ts
const IMAGE_LIMIT = 6e5;
const IMAGES_LIMIT = 4e6;
const RETAINED = 65536;
const VIEWPORTS = [{
	viewport: "desktop",
	width: 1280,
	height: 800
}, {
	viewport: "mobile",
	width: 390,
	height: 844
}];
const LOCAL_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})\/?$/;
const PAGE = /^\/(?!\/)[^\s\\\x00-\x1f\x7f]{0,199}$/;
const SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGHUP"
];
const NO_PLAYWRIGHT = /Executable doesn't exist|playwright install|npx canceled|missing packages/i;
const SCREENSHOTS_SKIPPED = "Screenshots skipped: Playwright or its browser is not installed here. Enable them with: npx playwright install chromium";
const PROOF_FILE = ".braid/proof.json";
const line = (label) => {
	const message = `${label} in ${PROOF_FILE} is one line of at most 300 characters.`;
	return /* @__PURE__ */ pipe(/* @__PURE__ */ string(message), /* @__PURE__ */ maxLength(300, message), /* @__PURE__ */ check((value) => !/[\x00-\x1f\x7f]/.test(value), message), /* @__PURE__ */ trim(), /* @__PURE__ */ nonEmpty(message));
};
const seconds = (label, fallback, max) => {
	const message = `${label} in ${PROOF_FILE} is a whole number of seconds from 1 to ${max}.`;
	return /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ number(message), /* @__PURE__ */ integer(message), /* @__PURE__ */ minValue(1, message), /* @__PURE__ */ maxValue(max, message)), fallback);
};
const URL_MESSAGE = "preview.url must be http://127.0.0.1, http://localhost or http://[::1] with a port, such as http://127.0.0.1:4319.";
const PAGES = `List 1 to 6 preview pages in ${PROOF_FILE}, each a path such as /settings starting with a single slash.`;
const CHECKS = `List at most 10 checks in ${PROOF_FILE}.`;
/** One-line shell checks, and optionally a preview served on a local port with the pages to screenshot. Unknown fields are refused. */
const proofSchema = /* @__PURE__ */ pipe(/* @__PURE__ */ strictObject({
	checks: /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ array(line("Each check"), CHECKS), /* @__PURE__ */ maxLength(10, CHECKS)), []),
	timeoutSeconds: seconds("timeoutSeconds", 600, 3600),
	preview: /* @__PURE__ */ optional$1(/* @__PURE__ */ strictObject({
		command: line("The preview command"),
		url: /* @__PURE__ */ pipe(/* @__PURE__ */ string(URL_MESSAGE), /* @__PURE__ */ regex(LOCAL_URL, URL_MESSAGE), /* @__PURE__ */ check((url) => Number(LOCAL_URL.exec(url)?.[1]) <= 65535, URL_MESSAGE), /* @__PURE__ */ transform((url) => new URL(url).origin)),
		pages: /* @__PURE__ */ optional$1(/* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ pipe(/* @__PURE__ */ string(PAGES), /* @__PURE__ */ regex(PAGE, PAGES)), PAGES), /* @__PURE__ */ minLength(1, PAGES), /* @__PURE__ */ maxLength(6, PAGES)), ["/"]),
		timeoutSeconds: seconds("preview.timeoutSeconds", 120, 600)
	}, `preview in ${PROOF_FILE} is an object with command, url, pages and timeoutSeconds.`))
}, `${PROOF_FILE} is an object with checks, timeoutSeconds and preview.`), /* @__PURE__ */ check((proof) => proof.checks.length > 0 || proof.preview !== void 0, `List checks or a preview in ${PROOF_FILE}.`), /* @__PURE__ */ check((proof) => !proof.preview || proof.checks.length <= 9, `List at most 9 checks with a preview in ${PROOF_FILE}; a preview that does not start is reported as the tenth.`));
/** Reads and checks the repository's proof file: a regular file of at most 16 KB, never followed through a symlink. */
function readProof(root, secrets) {
	let bytes;
	try {
		bytes = readRegularFile(join(root, PROOF_FILE), 16384);
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT") fail(`Add ${PROOF_FILE} to use --proof; braid submit --help shows its format.`);
		if (code !== "ELOOP") throw error;
	}
	const text = bytes?.toString("utf8") ?? fail(`${PROOF_FILE} must be a regular file of at most 16 KB.`);
	assertNoSecrets(text, secrets, `${PROOF_FILE} looks like it contains a credential. Keep secrets out of it; checks can read them from the environment.`);
	const parsed = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(void 0, `${PROOF_FILE} is not valid JSON.`), proofSchema), text);
	return parsed.success ? parsed.output : fail(parsed.issues[0].message);
}
const withNote = (output, extra) => !extra ? output : !output ? extra : `${output}${output.endsWith("\n") ? "" : "\n"}${extra}`;
const lastLine = (value) => screenText(value).split("\n").map((row) => row.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? "the screenshot tool failed.";
/** The end of what a command printed, as plain text. Output that looks like a credential stops the submission. */
function proofOutput(raw, command, secrets) {
	const text = screenText(raw);
	if (hasSecret(text.slice(-8512), secrets)) fail(`The output of ${command} looks like it contains a credential, so nothing was submitted. Stop it printing secrets, then submit again.`);
	const output = text.slice(-8e3);
	return /^[\uDC00-\uDFFF]/.test(output) ? output.slice(1) : output;
}
/** The type and size of a PNG or JPEG from its header, or null for anything else. */
function imageInfo(bytes) {
	if (bytes.length >= 24 && bytes.readUInt32BE(0) === 2303741511 && bytes.readUInt32BE(4) === 218765834 && bytes.toString("latin1", 12, 16) === "IHDR") {
		const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
		return width && height ? {
			contentType: "image/png",
			width,
			height
		} : null;
	}
	if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
	for (let offset = 2; offset + 9 <= bytes.length;) {
		if (bytes[offset] !== 255) return null;
		const marker = bytes[offset + 1];
		if (marker === 255) {
			offset++;
			continue;
		}
		if (marker === 1 || marker >= 208 && marker <= 216) {
			offset += 2;
			continue;
		}
		if (marker >= 192 && marker <= 207 && ![
			196,
			200,
			204
		].includes(marker)) {
			const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
			return width && height ? {
				contentType: "image/jpeg",
				width,
				height
			} : null;
		}
		offset += 2 + bytes.readUInt16BE(offset + 2);
	}
	return null;
}
/** A regular file the screenshot tool wrote, never followed through a symlink. */
function readImage(path) {
	try {
		return readRegularFile(path, 67108864);
	} catch {
		return;
	}
}
const exitStatus = ({ code, signal, error }) => error ? 127 : code ?? 128 + (signal ? constants$1.signals[signal] ?? 0 : 0);
/**
* The processes one proof starts. Each runs in its own process group (its process tree on Windows), so stopping it
* stops everything it started. A signal to braid stops them all, and close stops whatever is left.
*/
function processSession(context) {
	const running = /* @__PURE__ */ new Set(), windows = process.platform === "win32";
	let stopped;
	const send = (run, signal) => {
		try {
			if (windows) execFileSync("taskkill", [
				"/pid",
				String(run.child.pid),
				"/T",
				"/F"
			], {
				stdio: "ignore",
				windowsHide: true
			});
			else process.kill(-run.child.pid, signal);
		} catch {}
	};
	const alive = (run) => {
		if (!run.child.pid) return false;
		if (windows) return !run.ended;
		try {
			process.kill(-run.child.pid, 0);
			return true;
		} catch (error) {
			return error.code === "EPERM";
		}
	};
	const stop = async (run) => {
		for (const signal of ["SIGTERM", "SIGKILL"]) {
			if (!alive(run)) return;
			send(run, signal);
			for (let waited = 0; waited < 2e3 && alive(run); waited += 50) await setTimeout$1(50);
		}
	};
	const listeners = SIGNALS.map((signal) => [signal, () => {
		stopped ??= signal;
		for (const run of running) stop(run);
	}]);
	for (const [signal, listener] of listeners) context.signals.on(signal, listener);
	const session = {
		check() {
			if (stopped) fail(`Stopped by ${stopped}. The checks and preview were stopped and nothing was submitted.`);
		},
		start(file, args, options) {
			session.check();
			const child = spawn(file, args, {
				...options,
				detached: !windows,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsHide: true
			});
			const kept = [];
			let size = 0;
			const keep = (chunk) => {
				kept.push(chunk);
				size += chunk.length;
				if (size > 2 * RETAINED) {
					const recent = Buffer.concat(kept).subarray(-65536);
					kept.splice(0, kept.length, recent);
					size = recent.length;
				}
			};
			child.stdout?.on("data", keep);
			child.stderr?.on("data", keep);
			const run = {
				child,
				ended: false,
				text: () => Buffer.concat(kept).subarray(-65536).toString("utf8"),
				closed: new Promise((resolve) => child.once("close", resolve)),
				exited: new Promise((resolve) => {
					child.once("exit", (code, signal) => resolve({
						code,
						signal
					}));
					child.once("error", (error) => resolve({
						code: null,
						signal: null,
						error
					}));
				}).then((result) => {
					run.ended = true;
					return result;
				})
			};
			running.add(run);
			return run;
		},
		halt(run) {
			stop(run);
		},
		stop,
		/** Waits for the process, stops anything it left behind in its group and collects the rest of its output. */
		async finish(run) {
			const result = await run.exited;
			await stop(run);
			await Promise.race([run.closed, setTimeout$1(2e3, void 0, { ref: false })]);
			run.child.stdout?.destroy();
			run.child.stderr?.destroy();
			running.delete(run);
			return result;
		},
		async close() {
			for (const [signal, listener] of listeners) context.signals.off(signal, listener);
			await Promise.all([...running].map(stop));
		}
	};
	return session;
}
async function runCheck(context, session, root, env, command, timeout, secrets) {
	const started = performance.now(), run = session.start(command, [], {
		cwd: root,
		env,
		shell: true
	});
	let late = false;
	const timer = setTimeout(() => {
		late = true;
		session.halt(run);
	}, timeout * 1e3);
	const result = await session.finish(run);
	clearTimeout(timer);
	session.check();
	const exitCode = late ? 124 : exitStatus(result), durationMs = Math.round(performance.now() - started);
	const output = proofOutput(withNote(run.text(), late ? `Stopped after ${timeout} s.` : result.error?.message), command, secrets);
	note(context, `Proof: ${command} ${late ? `timed out after ${timeout} s` : `exited ${exitCode} after ${Math.round(durationMs / 1e3)} s`}.`);
	return {
		kind: "command",
		command,
		exitCode,
		output,
		durationMs
	};
}
/** Whether anything answers HTTP at the url, whatever the status. */
async function answering(context, url) {
	try {
		await (await context.fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(2e3)
		})).body?.cancel();
		return true;
	} catch {
		return false;
	}
}
/** The local Playwright command line, which npx finds without installing anything: playwright, or else playwright-core. */
async function playwright(session, root, env) {
	const npx = process.platform === "win32" ? [process.execPath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")] : ["npx"];
	if (npx.length > 1 && !existsSync(npx[1])) return void 0;
	for (const name of ["playwright", "playwright-core"]) {
		const [file, ...prefix] = npx, args = [
			...prefix,
			"--no-install",
			name
		];
		const run = session.start(file, [...args, "--version"], {
			cwd: root,
			env
		});
		const timer = setTimeout(() => session.halt(run), 6e4);
		const result = await session.finish(run);
		clearTimeout(timer);
		session.check();
		if (result.code === 0) return {
			file,
			args
		};
	}
}
/** Screenshots every page at desktop and phone size; without Playwright or its browser they are skipped with one line on enabling them. */
async function screenshots(context, session, root, env, preview, folder) {
	const tool = await playwright(session, root, env), shots = [];
	let total = 0;
	if (!tool) {
		note(context, SCREENSHOTS_SKIPPED);
		return shots;
	}
	for (const [index, page] of preview.pages.entries()) for (const view of VIEWPORTS) {
		const file = join(folder, `${index}-${view.viewport}.jpg`);
		const run = session.start(tool.file, [
			...tool.args,
			"screenshot",
			`--viewport-size=${view.width},${view.height}`,
			"--wait-for-timeout=1000",
			new URL(page, preview.url).href,
			file
		], {
			cwd: root,
			env
		});
		const timer = setTimeout(() => session.halt(run), 9e4);
		const result = await session.finish(run);
		clearTimeout(timer);
		session.check();
		const image = result.code === 0 ? readImage(file) : void 0, info = image && imageInfo(image);
		if (!info && NO_PLAYWRIGHT.test(run.text())) {
			note(context, SCREENSHOTS_SKIPPED);
			return shots;
		}
		if (!image || !info) note(context, `Proof: no ${view.viewport} screenshot of ${page}: ${lastLine(run.text())}`);
		else if (image.length > IMAGE_LIMIT) note(context, `Proof: the ${view.viewport} screenshot of ${page} is over 600 KB, so it is not attached.`);
		else if ((total += image.length) > IMAGES_LIMIT) note(context, `Proof: the ${view.viewport} screenshot of ${page} would take the screenshots past 4 MB, so it is not attached.`);
		else shots.push({
			kind: "screenshot",
			page,
			viewport: view.viewport,
			width: info.width,
			height: info.height,
			contentType: info.contentType,
			data: image.toString("base64")
		});
	}
	note(context, `Proof: ${count(shots.length, "screenshot")} of ${preview.url}.`);
	return shots;
}
/** Starts the preview, waits for it to answer and screenshots its pages. A preview that never answers is reported as a failed command. */
async function previewEvidence(context, session, root, env, preview, folder, secrets) {
	if (await answering(context, preview.url)) fail(`Something already answers at ${preview.url}. Stop it so the screenshots show this checkout, then submit again.`);
	const started = performance.now(), run = session.start(preview.command, [], {
		cwd: root,
		env: {
			BROWSER: "none",
			...env
		},
		shell: true
	});
	try {
		const deadline = context.now() + preview.timeoutSeconds * 1e3;
		let ready = false;
		while (!ready && !run.ended && context.now() < deadline) {
			ready = await answering(context, preview.url);
			session.check();
			if (!ready) await Promise.race([context.sleep(250), run.exited]);
		}
		session.check();
		if (ready) return await screenshots(context, session, root, env, preview, folder);
		const early = run.ended;
		await session.stop(run);
		const result = await session.finish(run);
		const how = result.error ? result.error.message : result.code !== null ? `code ${result.code}` : result.signal;
		const reason = early ? `It exited with ${how} before ${preview.url} answered.` : `${preview.url} did not answer within ${preview.timeoutSeconds} s.`;
		note(context, `Proof: the preview did not start. ${reason}`);
		return [{
			kind: "command",
			command: preview.command,
			exitCode: early ? exitStatus(result) || 1 : 124,
			output: proofOutput(withNote(run.text(), reason), preview.command, secrets),
			durationMs: Math.round(performance.now() - started)
		}];
	} finally {
		await session.stop(run);
	}
}
/**
* Runs a checked proof file in the repository and returns the evidence to attach; a failing check is evidence too.
* Checks must leave HEAD and tracked files as they were, or the proof would not describe what is submitted.
*/
async function runProof(context, root, proof, secrets) {
	const env = {
		CI: "true",
		...Object.fromEntries(Object.entries(context.env).filter(([key]) => !/^BRAID_/i.test(key)))
	};
	const state = () => [[
		"rev-parse",
		"--verify",
		"HEAD"
	], [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=no",
		"--ignore-submodules=none"
	]].map((args) => git(context, args, { cwd: root }).toString("utf8")).join("\0");
	const before = state(), folder = mkdtempSync(join(tmpdir(), "braid-proof-")), session = processSession(context);
	try {
		chmodSync(folder, 448);
		const evidence = [];
		for (const command of proof.checks) evidence.push(await runCheck(context, session, root, env, command, proof.timeoutSeconds, secrets));
		if (proof.preview) evidence.push(...await previewEvidence(context, session, root, env, proof.preview, folder, secrets));
		if (state() !== before) fail("A check changed HEAD or tracked files, so its proof would not describe this submission. Undo or commit those changes, keep checks from editing tracked files, and submit again.");
		return evidence;
	} finally {
		await session.close();
		rmSync(folder, {
			recursive: true,
			force: true
		});
	}
}
//#endregion
//#region ../shared/routes.ts
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
//#endregion
//#region src/task.ts
const identifier = (value) => ID.test(value) ? value : fail("Invalid task, agent or repository id.");
const text$1 = (value, label, max) => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= max && !trimmed.includes("\0") ? trimmed : fail(`Give a ${label} of 1 to ${max} characters.`);
};
const sanitized = (max) => /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ trim(), /* @__PURE__ */ nonEmpty(), /* @__PURE__ */ maxLength(max), /* @__PURE__ */ check((value) => !value.includes("\0")));
const scopePath = /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ check((path) => path === "*" || validPath(path.replace(/\/$/, ""))));
const sameScope = (left, right) => left.length === right.length && left.every((path, index) => path === right[index]);
/** A task link from Braid: its origin, the task, and the repository and agent when the link names them. */
function taskLink(value) {
	if (!URL.canParse(value)) fail("Give the task link from Braid.");
	const url = new URL(value), home = normalizeOrigin(url.origin);
	if (url.username || url.password || url.hash || /[\x00-\x20\x7f\\]/.test(value)) fail("That is not a valid task link.");
	const match = /^\/(?:([^/]+)\/([^/]+)\/)?tasks\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/?$/.exec(url.pathname);
	if (!match || match[1] && (!SLUG.test(match[1]) || !SLUG.test(match[2])) || [...url.searchParams.keys()].some((key) => !["workspace", "agent"].includes(key)) || ["workspace", "agent"].some((key) => url.searchParams.getAll(key).length > 1)) fail("Use a task link from Braid, such as https://braid.example/owner/repo/tasks/ID.");
	const workspaceId = url.searchParams.get("workspace") ?? void 0, agentId = url.searchParams.get("agent") ?? void 0;
	if ([workspaceId, agentId].some((value) => value !== void 0 && !ID.test(value))) fail("That task link names an invalid repository or agent.");
	return {
		origin: home,
		missionId: match[3],
		workspaceId,
		agentId,
		...match[1] ? { repository: `${match[1]}/${match[2]}` } : {}
	};
}
/**
* .braid/task.json: the task, its repository and agent, the base the next submission is against and, after an
* update, the base Braid still reports until a submission against the newer one is accepted. Unknown fields are kept.
*/
const taskFile = /* @__PURE__ */ pipe(/* @__PURE__ */ looseObject({
	url: /* @__PURE__ */ string(),
	workspaceId: id,
	missionId: id,
	agentId: id,
	baseCommit: commit,
	scope: /* @__PURE__ */ array(scopePath),
	acceptedBase: /* @__PURE__ */ optional$1(commit),
	previousCommit: /* @__PURE__ */ optional$1(/* @__PURE__ */ nullable(commit)),
	submissionMode: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal("commits")),
	html_url: /* @__PURE__ */ optional$1(htmlUrl)
}), /* @__PURE__ */ check((task) => task.acceptedBase !== task.baseCommit && originOf(task.url) === task.url));
const taskPath = (root) => join(root, ".braid", "task.json");
function readTask(root) {
	if (!existsSync(join(root, ".braid"))) fail("This directory is not a Braid task checkout. Start one with braid task start and the task link.");
	realDirectory(join(root, ".braid"));
	return readPrivateJson(taskPath(root), taskFile, {
		max: 32768,
		readOnly: true,
		label: "Task metadata"
	}) ?? fail("This directory is not a Braid task checkout. Start one with braid task start and the task link.");
}
/** Writes only real changes, reading the file again first so fields another command changed meanwhile are kept. */
function saveTask(root, before, next) {
	const changed = [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(next)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]));
	if (!changed.length) return before;
	const result = { ...readTask(root) };
	for (const key of changed) if (next[key] === void 0) delete result[key];
	else result[key] = next[key];
	const checked = /* @__PURE__ */ safeParse(taskFile, result);
	if (!checked.success) fail("The task metadata changed while this command ran. Run it again.");
	writePrivateJson(taskPath(root), result);
	return checked.output;
}
function withPrevious(task, previousCommit) {
	const next = { ...task };
	if (previousCommit) next.previousCommit = previousCommit;
	else delete next.previousCommit;
	return next;
}
const connection = (credentials) => ({
	authorization: `Bearer ${credentials.accessToken}`,
	"x-braid-workspace": credentials.workspaceId
});
const missionPath = (task, action) => `${task.url}/api/missions/${encodeURIComponent(task.missionId)}/agents/${encodeURIComponent(task.agentId)}/${action}`;
const checkoutAnswer = /* @__PURE__ */ object({
	html_url: /* @__PURE__ */ optional$1(htmlUrl),
	pullRequest: /* @__PURE__ */ optional$1(pullRequestContext),
	reviewComments: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(reviewComment), []),
	missionId: /* @__PURE__ */ string(),
	agentId: /* @__PURE__ */ string(),
	baseCommit: commit,
	previousCommit: /* @__PURE__ */ optional$1(/* @__PURE__ */ nullable(commit)),
	scope: /* @__PURE__ */ array(scopePath),
	remote: /* @__PURE__ */ string(),
	token,
	title: sanitized(1200),
	intent: sanitized(12e3),
	context: /* @__PURE__ */ optional$1(/* @__PURE__ */ unknown())
});
/** What a checkout or update answer says, checked against the task asked for; nothing in it may look like a credential. */
async function checkoutDetails(context, response, home, missionId, agentId, credentials, path) {
	const answered = await answer(response, checkoutAnswer, {
		path,
		secrets: [credentials.accessToken]
	});
	if (answered.missionId !== missionId || answered.agentId !== agentId) fail("Braid returned checkout details for a different task.");
	const details = {
		...answered,
		remote: httpsRemote(answered.remote),
		context: typeof answered.context === "string" ? answered.context : JSON.stringify(answered.context ?? {}, null, 2)
	};
	const metadata = {
		url: home,
		workspaceId: credentials.workspaceId,
		missionId,
		agentId,
		baseCommit: details.baseCommit,
		previousCommit: details.previousCommit,
		scope: details.scope
	};
	assertNoSecrets(JSON.stringify(metadata) + brief(context, details, { origin: home }), [credentials.accessToken, details.token], "The task holds something that looks like a credential, so braid did not write it to disk.");
	return details;
}
const missions = /* @__PURE__ */ object({ missions: /* @__PURE__ */ array(/* @__PURE__ */ object({
	html_url: /* @__PURE__ */ optional$1(htmlUrl),
	id: /* @__PURE__ */ string(),
	source: /* @__PURE__ */ string(),
	execution: /* @__PURE__ */ string(),
	status: /* @__PURE__ */ string(),
	baseCommit: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
	agents: /* @__PURE__ */ array(/* @__PURE__ */ object({
		id: /* @__PURE__ */ string(),
		status: /* @__PURE__ */ string(),
		commit: /* @__PURE__ */ optional$1(/* @__PURE__ */ nullable(/* @__PURE__ */ string()))
	}))
})) });
const changePage = /* @__PURE__ */ object({ items: /* @__PURE__ */ array(/* @__PURE__ */ object({ id: changeId })) });
/** .braid/TASK.md: the task, its base and scope, its context, and how to work and submit with this CLI. */
function brief(context, details, { origin: home, acceptedBase, committed = false, single = false }) {
	const run = (...args) => `\`${command(context, ...args)}\``;
	const base = acceptedBase ? `Base commit: ${details.baseCommit}\n\nMain moved after the accepted base ${acceptedBase}. Merge or rebase ${details.baseCommit} into your work, resolve any conflicts and rerun the checks before submitting.` : `Base commit: ${details.baseCommit}`;
	const history = committed ? "Commit the result you want reviewed: submit sends committed work and refuses uncommitted files. Local branches and merges are fine while the base stays in history." : "Commit and integrate work locally as needed, preserving the pinned base in history.";
	return `# ${details.title}\n\n${details.intent}\n\n${base}\n\nScope:\n${details.scope.map((path) => `- ${path}`).join("\n")}\n\n## Task context\n\n${details.context}\n\n` + (details.pullRequest ? `## Pull request #${details.pullRequest.number}\n\n${details.pullRequest.outdated?.length ? `${details.pullRequest.outdated.map((item) => `#${item.number}`).join(", ")} changed since this was built. Run braid restack ${details.pullRequest.number}.` : details.pullRequest.next ?? details.pullRequest.status}${details.pullRequest.dependsOn?.length ? `\nDepends on ${details.pullRequest.dependsOn.map((item) => `#${item.number}`).join(", ")}` : ""}\n\n` : "") + (details.reviewComments.length ? `## Unresolved review comments\n\n${describeComments(details.reviewComments)}\n\n` : "") + `Complete the requested result. Choose your own plan, coding tools, subagents and isolation. Worktrees are optional. ${history} Run the repository checks yourself.\nSubmit it for review with ${run("task", "submit", "--summary", "What changed")} from this checkout. Test reports are agent-reported and unverified. To revise a proposal, submit again from this checkout; the revision replaces the previous proposal with the complete change from the base.\n` + (single ? `If main moves, ${run("task", "update")} fetches it without changing your branch or files.\n` : "") + `Add .braid/proof.json if the repository has none, and submit with --proof to attach the checks and screenshots it describes (see ${run("task", "submit", "--help")}). After submitting, run ${run("task", "wait")}; when the result comes back, fix exactly what it names and submit again. Keep going until it lands or Braid says a person must decide.\nRun ${run("task", "resume")} to refresh .braid/TASK.md with the owner’s latest task instructions without changing your work. Read it before continuing.\nAfter your connection expires, run ${run("connect", "--url", home)}, then ${run("task", "resume")} to renew this checkout.\nIf a submission is unconfirmed, ${run("task", "submit", "--retry")} resends its saved payload and key.\n`;
}
const receipt = /* @__PURE__ */ pipe(/* @__PURE__ */ object({
	url: /* @__PURE__ */ string(),
	workspaceId: /* @__PURE__ */ string(),
	missionId: /* @__PURE__ */ string(),
	agentId: /* @__PURE__ */ string(),
	key: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ regex(KEY)),
	body: /* @__PURE__ */ string(),
	status: /* @__PURE__ */ picklist([
		"pending",
		"complete",
		"rejected"
	]),
	commit: /* @__PURE__ */ optional$1(commit),
	html_url: /* @__PURE__ */ optional$1(htmlUrl)
}), /* @__PURE__ */ check((saved) => saved.status !== "complete" || !!saved.commit));
const RECEIPT_LIMIT = 50331648;
/** The saved submission for this task, which must be this task's: an uncertain one is never discarded. */
function readReceipt(root, task) {
	let saved;
	try {
		saved = readPrivateJson(join(root, ".braid", "submission.json"), receipt, {
			max: RECEIPT_LIMIT,
			label: "The saved submission"
		});
	} catch {
		return fail("Invalid submission receipt for this task. Do not discard an uncertain submission.");
	}
	if (saved && [
		"url",
		"workspaceId",
		"missionId",
		"agentId"
	].some((key) => saved[key] !== task[key])) fail("Invalid submission receipt for this task. Do not discard an uncertain submission.");
	return saved;
}
const receiptStatus = (root) => {
	try {
		return readPrivateJson(join(root, ".braid", "submission.json"), /* @__PURE__ */ looseObject({ status: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()) }), {
			max: RECEIPT_LIMIT,
			readOnly: true
		})?.status;
	} catch {
		return;
	}
};
/** Keeps every replaced receipt, so earlier accepted proposals stay recoverable under .braid/submissions. */
function archiveReceipt(root, saved) {
	const path = join(privateDirectory(join(root, ".braid", "submissions")), `${saved.key}.json`);
	const earlier = readPrivateJson(path, /* @__PURE__ */ looseObject({
		key: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		body: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
	}), {
		max: RECEIPT_LIMIT,
		label: "An archived receipt"
	});
	if (earlier && (earlier.key !== saved.key || earlier.body !== saved.body)) fail("An archived receipt conflicts with this submission. Inspect .braid/submissions before submitting again.");
	writePrivateJson(path, saved);
}
/** A saved body as a JSON object, to compare two submissions field by field. */
const fields = (body) => {
	const result = /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ unknown())), body);
	return result.success ? result.output : {};
};
/** Identical work, summary, tests and proof, ignoring which proposal it replaces. */
const sameWork = (left, right) => {
	const strip = (body) => {
		const { previousCommit: _, ...rest } = fields(body);
		return JSON.stringify(rest);
	};
	return strip(left) === strip(right);
};
/** The latest proposal to replace: a newer confirmed receipt wins over metadata from before it. */
function expectedPrevious(task, saved) {
	const recorded = task.previousCommit ?? null;
	if (saved?.status !== "complete") return recorded;
	return recorded === (fields(saved.body).previousCommit ?? null) || recorded === saved.commit ? saved.commit ?? null : recorded;
}
/** A proposal as Braid accepts it, checked again before every send, including a retry of a body saved earlier. */
const proposal = /* @__PURE__ */ object({
	dependsOn: /* @__PURE__ */ optional$1(dependencyInputs),
	baseCommit: commit,
	previousCommit: /* @__PURE__ */ optional$1(/* @__PURE__ */ nullable(commit)),
	summary: sanitized(1200),
	rationale: sanitized(6e3),
	model: /* @__PURE__ */ optional$1(sanitized(120)),
	files: /* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ object({
		path: /* @__PURE__ */ string(),
		content: /* @__PURE__ */ nullable(/* @__PURE__ */ string()),
		mode: /* @__PURE__ */ optional$1(/* @__PURE__ */ picklist(["100644", "100755"]))
	})), /* @__PURE__ */ minLength(1)),
	tests: /* @__PURE__ */ optional$1(testReports),
	evidence: /* @__PURE__ */ optional$1(/* @__PURE__ */ array(evidenceInput))
});
const readProposal = (body) => /* @__PURE__ */ safeParse(/* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ parseJson(), proposal), body);
function checkProposal(body, bases, secrets) {
	const result = readProposal(body);
	if (!result.success) return fail("The saved submission is not a valid proposal for this task. Do not discard an uncertain submission.");
	const payload = result.output;
	if (!bases.includes(payload.baseCommit)) fail("The saved submission does not match this task's base.");
	const paths = /* @__PURE__ */ new Set();
	for (const file of payload.files) {
		if (!validPath(file.path) || paths.has(file.path) || file.mode && file.content === null) fail(`${file.path} is a protected, repeated or invalid path in the proposal.`);
		paths.add(file.path);
		if (file.content === null) continue;
		const encoded = Buffer.from(file.content, "utf8");
		if (decodeText(encoded) !== file.content) fail("Only UTF-8 text files can be submitted.");
		assertNoSecrets(`${file.path}\n${file.content}`, secrets, `${file.path} looks like it contains a credential. Remove it before submitting.`);
		if (encoded.length > LIMITS.bytes) fail("Cloudflare Artifacts limits each Git blob to 32 MB.");
	}
	assertSubmittable(payload, secrets);
	return payload;
}
/** The approval for a task's repository, signing in for the person when none is saved. */
async function approved(context, home, workspaceId) {
	if (!context.env.BRAID_ACCESS_TOKEN && !savedCredentials(context.env, home).some((saved) => (!workspaceId || saved.workspaceId === workspaceId) && Date.parse(saved.expiresAt ?? "") > context.now())) await agentLogin(context, home, { workspace: workspaceId });
	return loadCredentials(context, home, workspaceId);
}
function checkoutCredentials(context, task) {
	const credentials = loadCredentials(context, task.url, task.workspaceId);
	if (credentials.workspaceId !== task.workspaceId) fail("The approved repository does not match this checkout. Connect to the right repository.");
	return credentials;
}
/** The existing task approval, shared with pull-request commands. */
function taskConnection(context, root) {
	return new Braid(context, checkoutCredentials(context, readTask(root)));
}
/** Adds `.braid/` to the checkout's own Git excludes, so task files never show up to be committed. */
function excludeBraid(context, root) {
	const path = resolve(root, strict(context, [
		"rev-parse",
		"--git-path",
		"info/exclude"
	], { cwd: root }).toString("utf8").trim());
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path) && !lstatSync(path).isFile()) fail("Git's exclude file must be a regular file.");
	const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 384);
	try {
		writeFileSync(fd, "\n.braid/\n");
	} finally {
		closeSync(fd);
	}
}
/** Prepares a checkout for one task: a new directory cloned at the task's base, or with `existing`, a clean checkout at it. */
async function checkoutTask(context, input) {
	const home = normalizeOrigin(input.url);
	const missionId = identifier(input.mission), agentId = identifier(input.agent);
	const requested = resolve(context.cwd, input.dir), dir = join(realpathSync(dirname(requested)), basename(requested));
	const credentials = loadCredentials(context, home, input.workspace);
	if (input.workspace && credentials.workspaceId !== input.workspace) fail("The approved repository does not match this task. Connect to its repository first.");
	if (input.existing) checkoutRoot(context, dir);
	else try {
		mkdirSync(dir, { mode: 448 });
	} catch {
		fail("Checkout needs a NEW directory with an existing parent. No existing directory will be changed.");
	}
	const path = `/api/missions/${missionId}/agents/${agentId}/checkout`;
	const response = await send(context, `${home}${path}`, {
		method: "POST",
		body: {},
		headers: connection(credentials)
	});
	if (!response.ok) fail(`Braid did not provide the checkout (HTTP ${response.status}). The new directory can be inspected or removed before retrying.`);
	const details = await checkoutDetails(context, response, home, missionId, agentId, credentials, path);
	const metadata = {
		url: home,
		workspaceId: credentials.workspaceId,
		missionId,
		agentId,
		baseCommit: details.baseCommit,
		scope: details.scope,
		...input.committed ? { submissionMode: "commits" } : {},
		...details.previousCommit ? { previousCommit: details.previousCommit } : {}
	};
	if (details.html_url) metadata.html_url = details.html_url;
	if (input.existing) fetchCommit(context, dir, details.remote, details.baseCommit, details.token);
	else {
		strict(context, [
			"clone",
			"--no-checkout",
			"--no-local",
			"--template=",
			"--",
			details.remote,
			dir
		], { token: details.token });
		strict(context, [
			"checkout",
			"--detach",
			"--no-recurse-submodules",
			metadata.baseCommit,
			"--"
		], { cwd: dir });
	}
	const root = checkoutRoot(context, dir);
	pinnedBase(context, root, metadata.baseCommit);
	excludeBraid(context, root);
	privateDirectory(join(root, ".braid"));
	if (existsSync(join(root, ".braid", "TASK.md"))) fail("An existing .braid/TASK.md would be overwritten. Keep it somewhere else before binding this task.");
	writePrivateJson(taskPath(root), metadata, { exclusive: true });
	writePrivate(join(root, ".braid", "TASK.md"), brief(context, details, {
		origin: home,
		committed: input.committed,
		single: input.single
	}), { exclusive: true });
	const revision = details.previousCommit ? ` Proposal ${details.previousCommit} was already submitted; a submission from this checkout replaces it.` : "";
	print(context, `Checkout ready at ${root}${details.html_url ? `\n${details.html_url}` : ""}\nRead .braid/TASK.md and AGENTS.md. Complete the task, run checks, and submit the integrated result.${revision}`);
	return metadata;
}
/** One entry point for starting and returning to a task. It never adopts an unrelated checkout. */
async function startTask(context, input) {
	const link = taskLink(input.link);
	const dir = resolve(context.cwd, input.dir ?? (existsSync(join(context.cwd, ".git")) ? "." : `braid-${link.missionId}`));
	let existing, bind = false;
	if (existsSync(dir)) {
		checkoutRoot(context, dir);
		if (existsSync(join(dir, ".braid"))) realDirectory(join(dir, ".braid"));
		if (!existsSync(taskPath(dir))) bind = true;
		else existing = readTask(dir);
		if (existing && (existing.url !== link.origin || existing.missionId !== link.missionId || link.workspaceId && existing.workspaceId !== link.workspaceId || link.agentId && existing.agentId !== link.agentId)) fail("This directory belongs to a different task. Choose a new --dir.");
		if (existing) pinnedBase(context, dir, existing.acceptedBase, existing.baseCommit);
	}
	const workspace = link.workspaceId ?? existing?.workspaceId;
	let credentials = await approved(context, link.origin, workspace);
	if (workspace && workspace !== credentials.workspaceId) fail("This task belongs to another repository. Connect to that repository, then run start again.");
	if (link.repository) {
		const path = `/api/repos/${link.repository}`;
		if ((await answer(await send(context, `${link.origin}${path}`, { headers: connection(credentials) }), /* @__PURE__ */ object({ workspaceId: id }), {
			path,
			secrets: [credentials.accessToken]
		})).workspaceId !== credentials.workspaceId) fail("This task belongs to another repository. Connect to that repository, then run start again.");
	}
	const read = () => send(context, `${link.origin}/api/state`, { headers: connection(credentials) });
	let response = await read();
	if (response.status === 401 && !context.env.BRAID_ACCESS_TOKEN) {
		await agentLogin(context, link.origin, { workspace: credentials.workspaceId });
		credentials = loadCredentials(context, link.origin, credentials.workspaceId);
		response = await read();
	}
	if (!response.ok) fail(`Cannot read the task (HTTP ${response.status}). Check your approved connection.`);
	const task = (await answer(response, missions, {
		path: "/api/state",
		secrets: [credentials.accessToken]
	})).missions.find((item) => item.id === link.missionId);
	if (!task || task.execution !== "local" || task.source !== "live") fail("No local task was found at this link in the approved repository.");
	const agentId = existing?.agentId ?? link.agentId ?? (task.agents.length === 1 ? task.agents[0].id : void 0);
	if (!agentId) fail("This task has several agents. Use the assigned agent's own link from Braid.");
	const agent = task.agents.find((item) => item.id === agentId) ?? fail("The requested agent was not found in this task.");
	const page = task.html_url ?? `${link.origin}/${link.repository ? `${link.repository}/` : ""}tasks/${link.missionId}${link.repository ? "" : `?workspace=${encodeURIComponent(credentials.workspaceId)}`}`;
	if (task.status === "merged" || agent.status === "merged") {
		print(context, `This task was merged into main, so there is nothing left to submit. Local files were not changed. ${page}`);
		return;
	}
	if (!["running", "review"].includes(task.status) || agent.status === "skipped") {
		print(context, `This task is no longer accepting work. Local files were not changed. ${page}`);
		return;
	}
	if (agent.status === "review" && !existing) {
		print(context, `Proposal ${agent.commit ?? ""} is in review at ${page}. To revise it, run start again from the checkout that submitted it. Nothing was changed here.`);
		return;
	}
	if (bind) {
		if (strict(context, [
			"rev-parse",
			"--verify",
			"HEAD"
		], { cwd: dir }).toString("utf8").trim() !== task.baseCommit || strictGit(context, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all"
		], { cwd: dir }).stdout.length) fail("Use a clean checkout at the task's base, or --dir NEW_DIRECTORY. Existing commits and edits must not become part of a new task.");
	}
	if (existing) await resumeTask(context, { dir });
	else await checkoutTask(context, {
		url: link.origin,
		mission: link.missionId,
		agent: agentId,
		dir,
		workspace: credentials.workspaceId,
		existing: bind,
		committed: true,
		single: task.agents.length === 1
	});
}
/** Renews the checkout's claim on its task, records Braid's latest proposal for it, and says what to do next. */
async function resumeTask(context, input) {
	const root = checkoutRoot(context, input.dir ?? "."), task = readTask(root);
	pinnedBase(context, root, task.acceptedBase, task.baseCommit);
	const credentials = checkoutCredentials(context, task);
	const response = await send(context, missionPath(task, "checkout"), {
		method: "POST",
		body: {},
		headers: connection(credentials)
	});
	if (!response.ok) fail(`Braid did not renew the checkout (HTTP ${response.status}). Check your connection and run resume again.`);
	const details = await checkoutDetails(context, response, task.url, task.missionId, task.agentId, credentials, "checkout");
	if (!sameScope(details.scope, task.scope) || ![task.baseCommit, task.acceptedBase].includes(details.baseCommit)) fail("Braid's answer does not match this checkout's base or scope.");
	let next = details.previousCommit === void 0 ? { ...task } : withPrevious(task, details.previousCommit);
	if (details.html_url) next.html_url = details.html_url;
	if (details.baseCommit === task.baseCommit) delete next.acceptedBase;
	next = saveTask(root, task, next);
	writePrivate(join(root, ".braid", "TASK.md"), brief(context, {
		...details,
		baseCommit: next.baseCommit
	}, {
		origin: task.url,
		acceptedBase: next.acceptedBase,
		committed: task.submissionMode === "commits"
	}));
	const guidance = receiptStatus(root) === "pending" ? `A saved submission is unconfirmed; resend it with ${command(context, "task", "submit", "--retry", ...checkoutArgs(context, root))} before submitting anything else.` : next.acceptedBase ? `Merge or rebase the fetched main commit ${next.baseCommit} into your work, rerun checks, then submit.` : next.previousCommit ? `Proposal ${next.previousCommit} is the latest result; submit again from this checkout to revise it.` : "Continue the task, run checks, and submit the result.";
	print(context, `Renewed the checkout for task ${task.missionId}, agent ${task.agentId}. ${guidance}${next.html_url ? `\n${next.html_url}` : ""}`);
	return next;
}
/** Fetches current main for a single-agent task and records it as the next submission's base, leaving branch and files alone. */
async function updateTask(context, input) {
	const root = checkoutRoot(context, input.dir ?? "."), task = readTask(root);
	pinnedBase(context, root, task.acceptedBase, task.baseCommit);
	const credentials = checkoutCredentials(context, task);
	privateDirectory(join(root, ".braid"));
	return withLock(join(root, ".braid", "submission.lock"), async () => {
		if (readReceipt(root, task)?.status === "pending") fail(`An earlier submission has no confirmed result. Resend it with ${command(context, "task", "submit", "--retry", ...checkoutArgs(context, root))} before updating; its saved payload is unchanged.`);
		const response = await send(context, missionPath(task, "update"), {
			method: "POST",
			body: {},
			headers: connection(credentials)
		});
		if (!response.ok) fail(`Braid did not accept the update (HTTP ${response.status}). Retry any unconfirmed submission first; only single-agent tasks can move to a newer main. Local files were not changed.`);
		const details = await checkoutDetails(context, response, task.url, task.missionId, task.agentId, credentials, "update");
		if (!sameScope(details.scope, task.scope)) fail("Braid's answer does not match this checkout's scope.");
		fetchCommit(context, root, details.remote, details.baseCommit, details.token);
		if (!hasCommit(context, root, details.baseCommit)) fail("The current main commit could not be fetched. Local files were not changed.");
		const accepted = task.acceptedBase ?? task.baseCommit;
		let next = details.previousCommit === void 0 ? { ...task } : withPrevious(task, details.previousCommit);
		if (details.html_url) next.html_url = details.html_url;
		next.baseCommit = details.baseCommit;
		if (details.baseCommit === accepted) delete next.acceptedBase;
		else next.acceptedBase = accepted;
		next = saveTask(root, task, next);
		writePrivate(join(root, ".braid", "TASK.md"), brief(context, details, {
			origin: task.url,
			acceptedBase: next.acceptedBase,
			committed: task.submissionMode === "commits",
			single: true
		}));
		if (!next.acceptedBase) print(context, `Main is at the accepted base ${next.baseCommit}, so this checkout is current. Local files were not changed.`);
		else {
			const fetched = details.baseCommit === task.baseCommit ? `Main is still at ${next.baseCommit}, which this checkout fetched earlier.` : `Fetched main at ${next.baseCommit} without changing your branch or files.`;
			print(context, `${fetched} Merge or rebase it into this checkout (for example, git merge ${next.baseCommit}), resolve any conflicts, and rerun the repository checks before submitting. Earlier test reports describe the previous base and are not carried over.`);
		}
		if (next.html_url) print(context, next.html_url);
		return next;
	});
}
/** Shares a milestone or blocker on the task; repeating the same message reuses its key, so a retry is never shown twice. */
async function progressTask(context, input) {
	const root = checkoutRoot(context, input.dir ?? "."), task = readTask(root), credentials = checkoutCredentials(context, task);
	const body = JSON.stringify({ message: text$1(input.message, "progress message", 1200) });
	assertNoSecrets(body, [credentials.accessToken], "The progress message looks like it contains a credential. Leave secrets out of it.");
	const path = join(root, ".braid", "progress.json"), target = missionPath(task, "progress");
	const saved = readPrivateJson(path, /* @__PURE__ */ looseObject({
		target: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		body: /* @__PURE__ */ optional$1(/* @__PURE__ */ string()),
		key: /* @__PURE__ */ optional$1(/* @__PURE__ */ string())
	}), {
		max: 8192,
		label: "Saved progress"
	});
	const key = saved?.body === body && saved.target === target && saved.key && KEY.test(saved.key) ? saved.key : randomUUID();
	writePrivateJson(path, {
		target,
		body,
		key
	});
	const response = await send(context, target, {
		method: "POST",
		json: body,
		headers: {
			...connection(credentials),
			"idempotency-key": key
		}
	});
	if (!response.ok) fail(`Progress was not confirmed (HTTP ${response.status}). Repeat the same command to retry.`);
	const result = await answer(response, /* @__PURE__ */ object({ html_url: /* @__PURE__ */ optional$1(htmlUrl) }), {
		path: target,
		secrets: [credentials.accessToken]
	});
	print(context, `Progress shared.${result.html_url ? `\n${result.html_url}` : ""}`);
}
/** What to tell an agent whose submission Braid refused, by why it was refused. */
function rejection(context, root, status, baseCommit, task) {
	const run = (...args) => command(context, "task", ...args, ...checkoutArgs(context, root));
	return `Braid refused the submission (HTTP ${status}). No proposal was confirmed. ${status === 409 ? baseCommit === (task.acceptedBase ?? task.baseCommit) ? `The task or its latest proposal changed: run ${run("resume")}, then submit again.` : `Main or the latest proposal changed: run ${run("update")}, integrate the fetched main commit, rerun checks and submit again.` : status === 413 ? "The proposal exceeds a size limit." : [401, 403].includes(status) ? `Check access, then run ${command(context, "task", "start")} with the task link.` : "Check the patch requirements."}`;
}
/**
* Submits the task's result: the complete change from its base, saved with an idempotency key before it is sent so
* an uncertain answer can be resent exactly. Identical work replays the saved request rather than becoming a new
* revision, and an unconfirmed submission blocks any other until it is retried.
*/
async function submitTask(context, input) {
	if (input.retry && [
		input.dependsOn,
		input.summary,
		input.rationale,
		input.model,
		input.tests,
		input.proof
	].some((value) => value !== void 0)) fail("--retry resends the saved submission exactly; leave out the description, model, tests and proof.");
	const root = checkoutRoot(context, input.dir ?? ".");
	privateDirectory(join(root, ".braid"));
	const task = readTask(root);
	pinnedBase(context, root, task.acceptedBase, task.baseCommit);
	const credentials = checkoutCredentials(context, task), secrets = [credentials.accessToken];
	const run = (...args) => command(context, "task", ...args, ...checkoutArgs(context, root));
	const follow = `\nNext, wait until it merges or needs changes:\n  ${run("wait")}`;
	await withLock(join(root, ".braid", "submission.lock"), async () => {
		let saved = readReceipt(root, task), body;
		if (input.retry) body = (saved ?? fail("There is no saved submission to retry.")).body;
		else {
			if (input.proof && saved?.status === "pending") fail(`An earlier submission has no confirmed result. Resend it with its saved proof using ${run("submit", "--retry")}, then submit again.`);
			const proof = input.proof ? readProof(root, secrets) : void 0;
			if (!isAncestor(context, root, task.baseCommit)) fail(task.acceptedBase ? `Merge or rebase the fetched main commit ${task.baseCommit} into this checkout, rerun the checks, then submit.` : "HEAD must descend from the task's base commit. Keep the task's history before submitting.");
			const previousCommit = expectedPrevious(task, saved);
			const earlier = input.summary === void 0 && saved ? readProposal(saved.body) : void 0;
			const described = earlier?.success ? earlier.output : void 0;
			if (input.summary === void 0 && !described) fail("Describe the result with --summary.");
			const summary = input.summary ?? described.summary, model = input.model ?? described?.model;
			const payload = {
				...input.dependsOn !== void 0 ? { dependsOn: input.dependsOn } : {},
				baseCommit: task.baseCommit,
				previousCommit,
				summary: text$1(summary, "summary", 1200),
				rationale: text$1(input.rationale ?? described?.rationale ?? summary, "rationale", 6e3),
				...model ? { model: text$1(model, "model", 120) } : {},
				files: collectProposal(context, root, task.baseCommit, secrets, task.submissionMode === "commits"),
				...input.tests ? { tests: readTests(context, input.tests) } : {}
			};
			if (proof) {
				const evidence = await runProof(context, root, proof, secrets);
				if (evidence.length) payload.evidence = evidence;
			}
			body = JSON.stringify(payload);
			if (saved && saved.body !== body && sameWork(saved.body, body) && (saved.status === "pending" || saved.status === "complete" && saved.commit === previousCommit)) body = saved.body;
			if (saved?.status === "pending" && saved.body !== body) fail(`An earlier submission has no confirmed result. Resend its exact saved payload with ${run("submit", "--retry")}; current edits will not be sent.`);
		}
		const payload = checkProposal(body, [task.baseCommit, task.acceptedBase], secrets);
		if (saved?.status === "complete" && saved.body === body) {
			print(context, `Previously submitted proposal ${saved.commit} for review. Tests are agent-reported and unverified.${saved.html_url ? `\n${saved.html_url}` : ""}${follow}`);
			return;
		}
		const uncertain = saved?.status === "pending";
		if (!saved || saved.body !== body) {
			if (saved) archiveReceipt(root, saved);
			saved = {
				url: task.url,
				workspaceId: task.workspaceId,
				missionId: task.missionId,
				agentId: task.agentId,
				key: randomUUID(),
				body,
				status: "pending"
			};
		}
		const pending = {
			...saved,
			status: "pending"
		};
		const journal = join(root, ".braid", "submission.json");
		writePrivateJson(journal, pending);
		const sent = async () => {
			try {
				return await send(context, missionPath(task, "submit"), {
					method: "POST",
					json: pending.body,
					timeout: 18e4,
					headers: {
						...connection(credentials),
						"idempotency-key": pending.key
					}
				});
			} catch (error) {
				if (error instanceof CliError) fail(`The submission's outcome is uncertain. Resend the saved payload and key with ${run("submit", "--retry")}.`);
				throw error;
			}
		};
		let response = await sent();
		if (response.status === 403) try {
			await resumeTask(context, { dir: root });
			response = await sent();
		} catch (error) {
			if (error instanceof CliError) fail(`Task access could not be renewed. Run ${command(context, "task", "start")} with the task link, then ${run("submit", "--retry")}. The saved submission is kept.`);
			throw error;
		}
		if (!response.ok) {
			if (!uncertain && [
				400,
				401,
				403,
				404,
				405,
				409,
				413,
				415,
				422
			].includes(response.status)) {
				writePrivateJson(journal, {
					...pending,
					status: "rejected"
				});
				fail(rejection(context, root, response.status, payload.baseCommit, task));
			}
			fail(`The submission is unconfirmed (HTTP ${response.status}). Resend the saved payload and key with ${run("submit", "--retry")}.`);
		}
		let result;
		try {
			result = await answer(response, /* @__PURE__ */ object({
				commit,
				html_url: /* @__PURE__ */ optional$1(htmlUrl)
			}), {
				path: "submit",
				secrets
			});
		} catch {
			return fail(`The submission's outcome is uncertain. Resend the saved payload and key with ${run("submit", "--retry")}.`);
		}
		const current = readTask(root), accepted = withPrevious(current, result.commit);
		if (payload.baseCommit === current.baseCommit) delete accepted.acceptedBase;
		saveTask(root, current, accepted);
		writePrivateJson(journal, {
			...pending,
			status: "complete",
			commit: result.commit,
			html_url: result.html_url
		});
		const replaced = payload.previousCommit ? `, replacing ${payload.previousCommit}` : "";
		print(context, `Submitted proposal ${result.commit} for review${replaced}. Tests are agent-reported and unverified.${result.html_url ? `\n${result.html_url}` : ""}${follow}`);
	});
}
/** Waits for what this checkout's task became: the change its result opened once the repository lands it through the queue. */
async function waitTask(context, input) {
	const root = checkoutRoot(context, input.dir ?? "."), task = readTask(root);
	const braid = new Braid(context, checkoutCredentials(context, task));
	await poll(context, input.timeout, async (late) => {
		const [latest] = (await braid.get(`/api/changes?task=${encodeURIComponent(task.missionId)}&limit=5`, changePage)).items;
		if (latest) {
			const change = await braid.get(`/api/changes/${latest.id}`, change$1);
			if (settled(change.status) || late()) {
				print(context, describeChange(change, braid.secrets) + nextStep(context, change, {
					root,
					origin: task.url,
					task: true
				}));
				return true;
			}
		} else if (late()) {
			print(context, `No change yet. The task becomes a change once its result is submitted and the repository lands through its queue; otherwise the owner lands it in Braid.${task.html_url ? `\n${task.html_url}` : ""}`);
			return true;
		}
		return false;
	});
}
/** Whether `root` is a task checkout, so branch commands can point there instead. */
const isTaskCheckout = (root) => existsSync(taskPath(root));
//#endregion
//#region src/commands/follow.ts
function target(context, flags) {
	const repository = openRepository(context), braid = connect(context, repository);
	const files = branchFiles(context, repository.root), state = readState(repository.root, files);
	const id = flags.change ?? state?.change?.id ?? fail(isTaskCheckout(repository.root) ? `This checkout belongs to a Braid task; follow it with ${command(context, "task", "wait")}.` : `This branch has not submitted a change. Submit one with ${command(context, "submit")}, or name one with --change.`);
	return {
		repository,
		braid,
		files,
		state,
		path: `/api/changes/${encodeURIComponent(id)}`
	};
}
function report(context, braid, change, { repository, files, state }) {
	if (state?.change?.id === change.id) writeState(files, {
		...state,
		change: {
			...state.change,
			revision: change.revision,
			status: change.status
		}
	});
	print(context, describeChange(change, braid.secrets) + nextStep(context, change, {
		root: repository.root,
		origin: braid.origin
	}));
}
async function status(flags) {
	const repository = openRepository(this), activity = activityStatus(this, repository);
	print(this, `Connection: ${activity.connected ? "connected" : "disconnected"}${activity.origin ? ` · ${activity.origin}` : ""}${activity.workspaceId ? ` / ${activity.workspaceId}` : ""}\nToken expiry: ${activity.expiry ?? (this.env.BRAID_ACCESS_TOKEN ? "provided by environment" : "not signed in")}${activity.expiry && Date.parse(activity.expiry) <= this.now() ? " · run braid login" : ""}\nQueued activity: ${activity.queued}\nLast activity error: ${activity.lastError ?? "none"}`);
	startActivityUpload(this, repository.root);
	if (!flags.change && !readState(repository.root, branchFiles(this, repository.root))?.change) return;
	const found = target(this, flags);
	report(this, found.braid, await found.braid.get(found.path, change$1), found);
}
async function wait$1(flags) {
	const found = target(this, flags);
	let waiting = "";
	await poll(this, flags.timeout, async (late) => {
		const change = await found.braid.get(found.path, change$1);
		if (settled(change.status) || late()) {
			report(this, found.braid, change, found);
			return true;
		}
		const next = change.waitingOn?.length ? change.next ?? `Waiting on ${change.waitingOn.map((item) => `#${item.number}`).join(", ")}` : "";
		if (next && next !== waiting) print(this, next);
		waiting = next;
		return false;
	});
}
async function sync() {
	const repository = openRepository(this), { root } = repository, braid = connect(this, repository);
	const files = branchFiles(this, root), state = readState(root, files);
	const current = await braid.post("/api/changes/checkout", {}, trunk);
	fetchCommit(this, root, current.remote, current.head, current.token);
	const head = gitText(this, ["rev-parse", "HEAD"], { cwd: root }), short = current.head.slice(0, 12);
	const clean = !git(this, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=no"
	], { cwd: root }).length;
	if (head === current.head) {
		print(this, `Already at main ${short}.`);
		return;
	}
	if (clean && (head === state?.base || !state) && git(this, [
		"rev-list",
		"--count",
		`${current.head}..HEAD`
	], { cwd: root }).toString("utf8").trim() === "0") {
		git(this, [
			"merge",
			"--ff-only",
			"--quiet",
			current.head
		], { cwd: root });
		if (state) writeState(files, {
			...state,
			base: current.head,
			nextBase: void 0
		});
		print(this, `Moved to main ${short}.`);
		return;
	}
	if (state) writeState(files, {
		...state,
		nextBase: current.head
	});
	print(this, `Fetched main ${short}. Rebase onto it, resolve any conflicts and rerun the checks, then submit:\n  git rebase ${current.head}\n  ${command(this, "submit")}`);
}
const change = {
	kind: "parsed",
	parse: String,
	brief: "A change id or number; this branch's change when not given",
	placeholder: "change",
	optional: true
};
const statusCommand = buildCommand({
	func: status,
	parameters: { flags: { change } },
	docs: { brief: "Show where this branch's change stands and what to do next" }
});
const waitCommand = buildCommand({
	func: wait$1,
	parameters: { flags: {
		change,
		timeout: {
			kind: "parsed",
			parse: numberParser,
			brief: "Seconds to wait at most",
			placeholder: "seconds",
			default: "1800"
		}
	} },
	docs: { brief: "Wait until the pull request merges or needs changes, then say exactly what to fix" }
});
const syncCommand = buildCommand({
	func: sync,
	parameters: {},
	docs: { brief: "Fetch Braid's current main to rebase onto" }
});
const restackCommand = buildCommand({
	func: async function(_flags, number) {
		if (!Number.isSafeInteger(number) || number < 1) fail("Provide a positive pull request number.");
		const root = checkoutRoot(this, ".");
		const task = isTaskCheckout(root), found = task ? void 0 : target(this, { change: String(number) });
		const braid = found?.braid ?? taskConnection(this, root), path = `/api/changes/${number}`;
		const file = join(found?.files.folder ?? privateDirectory(join(root, ".braid")), `restack-${number}.json`);
		await withLock(file + ".lock", async () => {
			let saved = readPrivateJson(file, restackReceipt, {
				max: 4096,
				label: "The saved restack"
			});
			if (saved && (saved.origin !== braid.origin || saved.workspaceId !== braid.credentials.workspaceId)) fail("The saved restack belongs to another repository.");
			if (!saved?.pending) {
				const current = await braid.get(path, change$1);
				saved = {
					key: randomUUID(),
					previousRevision: current.revision,
					pending: true,
					origin: braid.origin,
					workspaceId: braid.credentials.workspaceId
				};
				writePrivateJson(file, saved);
			}
			try {
				const next = await braid.post(`${path}/restack`, { previousRevision: saved.previousRevision }, change$1, { key: saved.key });
				writePrivateJson(file, {
					...saved,
					pending: false
				});
				if (found) report(this, braid, next, found);
				else print(this, describeChange(next, braid.secrets) + nextStep(this, next, {
					root,
					origin: braid.origin,
					task
				}));
				print(this, "Local commits and files are unchanged.");
			} catch (error) {
				if (error instanceof ApiError && [
					400,
					403,
					404,
					409
				].includes(error.status)) writePrivateJson(file, {
					...saved,
					pending: false
				});
				throw error;
			}
		});
	},
	parameters: { positional: {
		kind: "tuple",
		parameters: [{
			brief: "The pull request number",
			placeholder: "number",
			parse: numberParser
		}]
	} },
	docs: { brief: "Reapply a pull request onto its updated prerequisites" }
});
//#endregion
//#region src/hooks.ts
const MARKER = "# braid-hook v1";
const CHAINED = ".pre-braid";
const HOOK = `#!/bin/sh
${MARKER}: under \`braid agent run\`, records the run in a refs/notes/braid note on the new commit.
# Installed by \`braid init\`; the hook that was here before runs first as post-commit${CHAINED}.
previous="$(dirname "$0")/post-commit${CHAINED}"
if [ -x "$previous" ]; then "$previous" "$@"; fi
if [ -n "$BRAID_MODEL$BRAID_TOOL$BRAID_SESSION" ] && command -v braid >/dev/null 2>&1; then braid hook post-commit >/dev/null 2>&1; fi
exit 0
`;
const present = (path) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};
const ours = (path) => {
	try {
		return readFileSync(path, "utf8").includes(MARKER);
	} catch {
		return false;
	}
};
function retire(folder) {
	const path = join(folder, "prepare-commit-msg"), previous = `${path}${CHAINED}`;
	const braids = present(path) && ours(path);
	if (present(path) && !braids) return present(previous) ? "set aside" : void 0;
	if (braids) rmSync(path);
	if (present(previous)) {
		renameSync(previous, path);
		return "restored";
	}
	return braids ? "removed" : void 0;
}
function installHooks(context, root) {
	const folder = gitPath(context, root, "hooks");
	mkdirSync(folder, { recursive: true });
	const path = join(folder, "post-commit"), previous = `${path}${CHAINED}`;
	if (present(path) && !ours(path)) {
		if (present(previous)) fail(`${path} replaced Braid's hook, and ${previous} is already chained. Merge the two hooks into ${previous}, then run braid init again.`);
		renameSync(path, previous);
	}
	writeFileSync(path, HOOK, { mode: 493 });
	chmodSync(path, 493);
	return {
		folder,
		chained: present(previous),
		earlier: retire(folder)
	};
}
function replaying(context, root) {
	return [
		"rebase-merge",
		"rebase-apply",
		"CHERRY_PICK_HEAD"
	].some((name) => existsSync(gitPath(context, root, name)));
}
function runNote(run) {
	if (!run.model && !run.tool && !run.session) return void 0;
	return {
		v: 1,
		agent: {
			name: coAuthor(run.model, run.tool).name,
			id: run.agentId,
			model: run.model,
			tool: run.tool,
			session: run.session,
			parentSession: run.parentSession
		}
	};
}
function recordRun(context, root, run, commit = "HEAD") {
	const note = runNote(run);
	if (!note || replaying(context, root)) return false;
	git(context, [
		"notes",
		`--ref=${NOTES_REF}`,
		"add",
		"--force",
		"--message",
		formatNote(note).trimEnd(),
		commit
	], { cwd: root });
	return true;
}
const canCommit = (context, root) => gitTry(context, ["var", "GIT_COMMITTER_IDENT"], { cwd: root }).status === 0;
//#endregion
//#region src/commands/hook.ts
async function committed() {
	const { root } = openRepository(this);
	if (canCommit(this, root)) recordRun(this, root, detectRun(this));
	if (this.env.BRAID_ACTIVITY_DIR) try {
		queueActivity(this.env.BRAID_ACTIVITY_DIR, {
			source: "git",
			kind: "commit",
			commit: gitText(this, ["rev-parse", "HEAD"], { cwd: root })
		}, this.now());
	} catch {}
}
const hookRoutes = buildRouteMap({
	routes: {
		"post-commit": buildCommand({
			func: committed,
			parameters: {},
			docs: { brief: "Record the agent run in a refs/notes/braid note on HEAD" }
		}),
		activity: buildCommand({
			func: async function(_flags, source, payload) {
				await recordActivityHook(this, source, payload);
			},
			parameters: { positional: {
				kind: "tuple",
				parameters: [{
					parse: String,
					brief: "Hook provider",
					placeholder: "provider"
				}, {
					parse: String,
					brief: "Notification payload",
					placeholder: "payload",
					optional: true
				}]
			} },
			docs: { brief: "Queue a local observation" }
		}),
		upload: buildCommand({
			func: async function(_flags, root) {
				await uploadActivity(this, root);
			},
			parameters: { positional: {
				kind: "tuple",
				parameters: [{
					parse: String,
					brief: "Checkout root",
					placeholder: "directory"
				}]
			} },
			docs: { brief: "Deliver queued activity" }
		})
	},
	docs: { brief: "What the Git hook from braid init runs" }
});
//#endregion
//#region src/commands/init.ts
function linkRemote(context, root, url) {
	const current = currentRemote(context, root);
	if (current === void 0) git(context, [
		"remote",
		"add",
		"braid",
		url
	], { cwd: root });
	else if (current !== url) git(context, [
		"remote",
		"set-url",
		"braid",
		url
	], { cwd: root });
	const key = `credential.${url}`;
	gitTry(context, [
		"config",
		"--local",
		"--unset-all",
		`${key}.helper`
	], { cwd: root });
	git(context, [
		"config",
		"--local",
		"--add",
		`${key}.helper`,
		""
	], { cwd: root });
	git(context, [
		"config",
		"--local",
		"--add",
		`${key}.helper`,
		`!${shellCommand([...context.self, "git-credential"])}`
	], { cwd: root });
	git(context, [
		"config",
		"--local",
		`${key}.useHttpPath`,
		"true"
	], { cwd: root });
}
async function init(flags) {
	const repository = openRepository(this);
	const origin = resolveOrigin(this, repository.link, flags.url);
	const signedIn = [...new Set(savedCredentials(this.env, origin).filter((saved) => Date.parse(saved.expiresAt ?? "") > this.now()).map((saved) => saved.workspaceId))];
	const workspaceId = flags.workspace ?? this.env.BRAID_WORKSPACE_ID ?? repository.link?.workspaceId ?? (signedIn.length === 1 ? signedIn[0] : fail(signedIn.length ? `Several repositories are signed in at ${origin}; choose one with --workspace.` : `Run braid login --url ${origin} first, or name the repository with --workspace.`));
	if (!ID.test(workspaceId)) fail(`${workspaceId} is not a Braid repository id.`);
	const path = writeLink(repository.root, {
		url: origin,
		workspaceId
	});
	linkRemote(this, repository.root, braidRemote(origin, workspaceId));
	const hooks = installHooks(this, repository.root), folder = relative(repository.root, hooks.folder) || hooks.folder;
	print(this, `Linked to ${origin}, repository ${workspaceId}, in ${relative(this.cwd, path) || path}.`);
	print(this, `Added the braid remote, signed in through braid: git push braid HEAD:refs/for/main opens a change.`);
	print(this, `Installed the post-commit hook in ${folder}${hooks.chained ? "; the post-commit hook already there runs first" : ""}.`);
	if (hooks.earlier === "restored") print(this, `Removed Braid's earlier prepare-commit-msg hook and put back the one it had set aside.`);
	if (hooks.earlier === "removed") print(this, `Removed Braid's earlier prepare-commit-msg hook.`);
	if (hooks.earlier === "set aside") print(this, `${folder}/prepare-commit-msg.pre-braid is a hook Braid once set aside, and it no longer runs. Merge it into prepare-commit-msg or delete it.`);
}
const initCommand = buildCommand({
	func: init,
	parameters: { flags: {
		url: {
			kind: "parsed",
			parse: normalizeOrigin,
			brief: "Braid address, such as https://braid.example",
			placeholder: "url",
			optional: true
		},
		workspace: {
			kind: "parsed",
			parse: String,
			brief: "Repository id at that Braid",
			placeholder: "id",
			optional: true
		}
	} },
	docs: {
		brief: "Link this repository to Braid, add the braid remote and install the post-commit hook",
		fullDescription: "Writes .braid/config.json with the Braid address and repository id, adds a braid Git remote that signs in through braid's own credential helper, so git push braid HEAD:refs/for/main opens a change, and installs a post-commit hook that records each commit made under braid agent run (model, tool and session) in a refs/notes/braid note. Braid never changes commit messages. A post-commit hook already there keeps running first, and the prepare-commit-msg hook of earlier versions is removed, with the hook it had set aside put back."
	}
});
//#endregion
//#region ../shared/instructions-file.ts
/** At most 100 instructions of 500 characters, each blocking up to 8 strings of 60 characters in up to 10 path patterns. */
const INSTRUCTION_LIMITS = {
	count: 100,
	text: 500,
	block: 8,
	blocked: 60,
	paths: 10
};
const TEXT = "Write the instruction in 1–500 characters.";
const BLOCK = "Block up to 8 strings of 1–60 characters, each on one line.";
const PATHS = "Limit an instruction to up to 10 path patterns such as src/**.";
/** What every agent should do, as one line. */
const instructionText = /* @__PURE__ */ pipe(/* @__PURE__ */ string(TEXT), /* @__PURE__ */ transform((text) => text.replace(/\s+/g, " ").trim()), /* @__PURE__ */ nonEmpty(TEXT), /* @__PURE__ */ maxLength(INSTRUCTION_LIMITS.text, TEXT));
/** Strings a change may not add, matched exactly as written; an empty list blocks nothing. */
const blockedStrings = /* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ pipe(/* @__PURE__ */ string(BLOCK), /* @__PURE__ */ maxLength(INSTRUCTION_LIMITS.blocked, BLOCK), /* @__PURE__ */ check((value) => value.trim() !== "" && !/[\x00-\x08\x0a-\x1f\x7f]/.test(value), BLOCK)), BLOCK), /* @__PURE__ */ maxLength(INSTRUCTION_LIMITS.block, BLOCK), /* @__PURE__ */ transform((list) => list.length ? list : void 0));
/** The files an instruction covers, matched as policy rules match paths; an empty list covers every file. */
const instructionPaths = /* @__PURE__ */ pipe(/* @__PURE__ */ array(/* @__PURE__ */ pipe(/* @__PURE__ */ string(PATHS), /* @__PURE__ */ trim(), /* @__PURE__ */ nonEmpty(PATHS), /* @__PURE__ */ maxLength(200, PATHS), /* @__PURE__ */ check((value) => !/[\x00-\x1f\x7f]/.test(value), PATHS)), PATHS), /* @__PURE__ */ maxLength(INSTRUCTION_LIMITS.paths, PATHS), /* @__PURE__ */ transform((list) => list.length ? list : void 0));
//#endregion
//#region src/commands/instructions.ts
async function list(flags) {
	const braid = connect(this, openRepository(this));
	const found = await braid.get("/api/instructions", instructions);
	if (flags.json) {
		print(this, JSON.stringify(found.instructions, null, 2));
		return;
	}
	const paint = colours(this), clean = (text) => redact(plain(text), braid.secrets);
	if (!found.instructions.length) print(this, "No instructions yet.");
	for (const instruction of found.instructions) {
		print(this, `${paint.dim(instruction.id)}  ${clean(instruction.text)}`);
		const scope = [instruction.block?.length ? `blocks ${instruction.block.map((item) => JSON.stringify(item)).join(", ")}` : "", instruction.paths?.length ? `in ${instruction.paths.join(", ")}` : ""].filter(Boolean).join(" ");
		if (scope) print(this, `  ${paint.dim(clean(scope))}`);
	}
	for (const problem of found.errors) note(this, `${paint.yellow("Warning:")} ${clean(problem)}`);
}
async function add(flags, text) {
	const input = /* @__PURE__ */ safeParse(/* @__PURE__ */ object({
		text: instructionText,
		block: /* @__PURE__ */ optional$1(blockedStrings),
		paths: /* @__PURE__ */ optional$1(instructionPaths)
	}), {
		text,
		block: flags.block?.length ? [...flags.block] : void 0,
		paths: flags.path?.length ? [...flags.path] : void 0
	});
	if (!input.success) fail(input.issues[0].message);
	const braid = connect(this, openRepository(this));
	try {
		const opened = await braid.post("/api/instructions", input.output, change$1);
		print(this, `Opened pull request #${opened.number} to add the instruction; it lands under the repository's rules.${opened.html_url ? `\n${opened.html_url}` : ""}`);
	} catch (error) {
		if (error instanceof ApiError && error.status === 403) fail(`Only a person can add instructions, and braid signs in as an agent. Add it in Braid at ${braid.origin}/settings/agents.`);
		throw error;
	}
}
const instructionRoutes = buildRouteMap({
	routes: {
		list: buildCommand({
			func: list,
			parameters: { flags: { json: {
				kind: "boolean",
				brief: "Print JSON",
				optional: true
			} } },
			docs: { brief: "List the instructions every agent follows here" }
		}),
		add: buildCommand({
			func: add,
			parameters: {
				flags: {
					block: {
						kind: "parsed",
						parse: String,
						variadic: true,
						optional: true,
						brief: "A string changes may not add; repeat for up to 8",
						placeholder: "text"
					},
					path: {
						kind: "parsed",
						parse: String,
						variadic: true,
						optional: true,
						brief: "Limit it to files matching this pattern, such as src/**; repeat for up to 10",
						placeholder: "pattern"
					}
				},
				positional: {
					kind: "tuple",
					parameters: [{
						brief: "What every agent should do, in one line",
						parse: String,
						placeholder: "text"
					}]
				}
			},
			docs: { brief: "Propose an instruction for every agent" }
		})
	},
	defaultCommand: "list",
	docs: { brief: "List and add the instructions every agent follows" }
});
//#endregion
//#region src/commands/log.ts
async function log(flags) {
	if (!Number.isInteger(flags.limit) || flags.limit < 1) fail("Use -n with a whole number of commits, such as -n 20.");
	const { root } = openRepository(this);
	const found = [];
	if (hasCommit(this, root, "HEAD")) {
		const index = noteIndex(this, root, NOTES_REF), batch = [];
		const filtered = !!(flags.agent || flags.model || flags.owner);
		const take = () => {
			for (const provenance of provenances(this, root, batch.splice(0), index)) if (found.length < flags.limit && matches(provenance, flags)) found.push(provenance);
		};
		for await (const commit of streamCommits(this, root, [
			...flags.since ? [`--since=${flags.since}`] : [],
			...filtered ? [] : ["-n", String(flags.limit)],
			"HEAD"
		])) {
			batch.push(commit);
			if (batch.length >= 200) {
				take();
				if (found.length >= flags.limit) break;
			}
		}
		take();
	}
	if (flags.json) {
		print(this, JSON.stringify(found, null, 2));
		return;
	}
	const logins = personLogins(found.map((provenance) => provenance.owner), found.length ? await historyLogins(this, root) : []);
	const paint = colours(this), now = this.now();
	const rows = found.map((provenance) => [
		provenance.commit.slice(0, 8),
		age(provenance.at, now),
		authorLabel(provenance, logins),
		ownerLabel(provenance, logins),
		changeLabel(provenance),
		redact(provenance.subject)
	]);
	fitLast(this, rows);
	for (const row of columns(rows, (cell, column, index) => column === 0 ? paint.yellow(cell) : column === 2 && found[index].kind === "agent" ? paint.cyan(cell) : column === 1 || column === 3 ? paint.dim(cell) : cell)) print(this, row);
}
const logCommand = buildCommand({
	func: log,
	parameters: {
		flags: {
			agent: {
				kind: "parsed",
				parse: String,
				brief: "Only commits by this agent, such as \"Claude Opus 5.5\" or copilot",
				placeholder: "name",
				optional: true
			},
			model: {
				kind: "parsed",
				parse: String,
				brief: "Only commits by this model, by id or display name",
				placeholder: "model",
				optional: true
			},
			owner: {
				kind: "parsed",
				parse: String,
				brief: "Only work by this person or their agents: name, @login or address",
				placeholder: "person",
				optional: true
			},
			since: {
				kind: "parsed",
				parse: String,
				brief: "Only commits after this date, as git log reads it, such as 2.weeks or 2026-10-01",
				placeholder: "date",
				optional: true
			},
			limit: {
				kind: "parsed",
				parse: numberParser,
				brief: "How many commits to show",
				placeholder: "n",
				default: "20"
			},
			json: {
				kind: "boolean",
				brief: "Print the provenance of each commit as JSON",
				optional: true
			}
		},
		aliases: { n: "limit" }
	},
	docs: { brief: "Show recent commits with the agent, person or bot behind each" }
});
//#endregion
//#region src/commands/submit.ts
const clip = (text, max) => [...text.trim()].slice(0, max).join("").trim();
async function trunkBase(context, braid, root) {
	const head = await braid.post("/api/changes/checkout", {}, trunk);
	fetchCommit(context, root, head.remote, head.head, head.token);
	if (isAncestor(context, root, head.head)) return {
		base: head.head,
		branch: head.branch
	};
	const shared = gitTry(context, [
		"merge-base",
		"HEAD",
		head.head
	], { cwd: root });
	return {
		base: shared.status === 0 ? shared.stdout.toString("utf8").trim() : fail(`This branch shares no history with Braid's main (${head.branch} at ${head.head.slice(0, 12)}).`),
		branch: head.branch
	};
}
function commitsSince(context, root, base) {
	const ids = gitText(context, [
		"rev-list",
		"--reverse",
		`${base}..HEAD`
	], { cwd: root }).split("\n").filter(Boolean);
	const found = readCommits(context, root, ids);
	return ids.flatMap((id) => found.get(id) ?? []);
}
function describe(commits) {
	const subject = (message) => message.split("\n", 1)[0].trim();
	const body = (message) => {
		const paragraphs = message.split(/\n\s*\n/).slice(1);
		while (paragraphs.length && (parseTrailers(`x\n\n${paragraphs.at(-1)}`).size || generatedFooter(paragraphs.at(-1)))) paragraphs.pop();
		return paragraphs.join("\n\n").trim();
	};
	const [first] = commits;
	if (!first) return {
		title: "Agent change",
		summary: "Agent change"
	};
	return commits.length === 1 ? {
		title: subject(first.message),
		summary: body(first.message) || subject(first.message)
	} : {
		title: subject(first.message),
		summary: commits.map((commit) => `- ${subject(commit.message)}`).join("\n")
	};
}
const PERSON = /^[^<>\x00-\x1f\x7f]*[^<>\s\x00-\x1f\x7f][^<>\x00-\x1f\x7f]* <[^<>\s@]+@[^<>\s]+>$/;
function coAuthors(commits) {
	const lines = commits.flatMap((commit) => parseTrailers(commit.message).get("co-authored-by") ?? []).filter((line) => line.length <= 200 && PERSON.test(line));
	return [...new Map(lines.map((line) => [line.toLowerCase(), line])).values()].slice(0, 5);
}
function committedRun(context, root, commits, flags) {
	const notes = readNotes(context, root, NOTES_REF, commits.map((commit) => commit.id));
	const latest = [...commits].reverse().map((commit) => parseNote(notes.get(commit.id) ?? "")?.agent).find(Boolean);
	return resolveRun(flags, context.env, {
		...detectRun(context, flags),
		...latest
	});
}
function noteCommits(context, root, commits, run) {
	if (!run.model || !canCommit(context, root)) return;
	try {
		const noted = noteIndex(context, root, NOTES_REF), model = coAuthor(run.model);
		const named = (commit) => (parseTrailers(commit.message).get("co-authored-by") ?? []).map(parsePerson).some((person) => person.email?.toLowerCase() === model.email.toLowerCase() && modelName(person.name).toLowerCase() === model.name.toLowerCase());
		for (const commit of commits) if (!noted.has(commit.id) && named(commit)) recordRun(context, root, run, commit.id);
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
	}
}
async function pushChange(context, braid, root, files, flags) {
	const url = braidRemote(braid.origin, braid.credentials.workspaceId);
	if (currentRemote(context, root) !== url) fail(`Add the braid remote with ${command(context, "init")} first.`);
	const { base, branch } = await trunkBase(context, braid, root);
	if (!/^(?!.*\.\.)[\w./-]{1,200}$/.test(branch)) fail("Braid returned a default branch name Git cannot push to.");
	validatePush(context, root, base, braid.secrets);
	noteCommits(context, root, commitsSince(context, root, base), detectRun(context, flags));
	const token = braid.credentials.accessToken;
	const notes = noteIndex(context, root, "refs/notes/braid").size ? [`${NOTES_REF}:${NOTES_REF}`] : [];
	const pushed = strictGit(context, [
		"push",
		url,
		`HEAD:refs/for/${branch}`,
		...notes
	], {
		cwd: root,
		token,
		quiet: false
	});
	const remote = pushed.stderr.split("\n").flatMap((line) => {
		const said = /^remote:\s*(.*)$/.exec(line)?.[1]?.trim();
		return said ? [said] : [];
	});
	if (pushed.status !== 0) fail(`Braid did not take the push${remote.length ? `:\n${remote.join("\n")}` : "."}`);
	for (const line of remote) note(context, `remote: ${line}`);
	const number = /\/pull\/(\d+)/.exec(remote.join("\n"))?.[1];
	if (!number) {
		print(context, `Pushed ${gitText(context, [
			"rev-parse",
			"--short=12",
			"HEAD"
		], { cwd: root })} to the braid remote as refs/for/${branch}.`);
		return;
	}
	const change = await braid.get(`/api/changes/${number}`, change$1);
	writeState(files, {
		origin: braid.origin,
		workspaceId: braid.credentials.workspaceId,
		base,
		change: {
			id: change.id,
			number: change.number,
			revision: change.revision,
			status: change.status,
			html_url: change.html_url
		}
	});
	attachActivity(context, root, braid.origin, braid.credentials.workspaceId, change);
	print(context, describeChange(change, braid.secrets) + nextStep(context, change, {
		root,
		origin: braid.origin
	}));
}
async function submit$1(flags) {
	if (flags.retry && [
		flags.title,
		flags.summary,
		flags.intent,
		flags.rationale,
		flags.model,
		flags.tool,
		flags.session,
		flags.parentSession,
		flags.tests,
		flags.proof,
		flags.push,
		flags.dependsOn
	].some((value) => value !== void 0)) fail("--retry resends the saved submission exactly; leave out the other flags.");
	if (flags.push && [
		flags.title,
		flags.summary,
		flags.intent,
		flags.rationale,
		flags.tests,
		flags.proof,
		flags.dependsOn
	].some((value) => value !== void 0)) fail("--push sends the commits over Git, so their messages describe the change; leave out the description, --tests, --proof and --depends-on.");
	const repository = openRepository(this), { root } = repository;
	if (isTaskCheckout(root)) fail(`This checkout belongs to a Braid task; submit its result with ${command(this, "task", "submit")}.`);
	const braid = connect(this, repository);
	const files = branchFiles(this, root);
	if (flags.push) return withLock(files.lock, () => pushChange(this, braid, root, files, flags));
	await withLock(files.lock, async () => {
		let saved = readJournal(files);
		const state = readState(root, files);
		if (state && (state.origin !== braid.origin || state.workspaceId !== braid.credentials.workspaceId)) fail(`This branch's change is on ${state.origin}, repository ${state.workspaceId}; braid is signed in to ${braid.origin}, repository ${braid.credentials.workspaceId}.`);
		if (flags.retry) {
			if (saved?.status !== "pending") fail("There is no unconfirmed submission from this branch to retry.");
		} else {
			if (saved?.status === "pending") fail(`An earlier submission from this branch is unconfirmed. Resend it exactly with ${command(this, "submit", "--retry")}, then submit again.`);
			const known = state?.change && !finished(state.change.status) ? state.change : void 0;
			const revising = known && !finished((await braid.get(`/api/changes/${known.id}`, change$1)).status) ? known : void 0;
			const base = revising && state ? state.nextBase && isAncestor(this, root, state.nextBase) ? state.nextBase : state.base : (await trunkBase(this, braid, root)).base;
			const proof = flags.proof ? readProof(root, braid.secrets) : void 0;
			const { files: changed } = collectChanges(this, root, base, braid.secrets);
			const commits = commitsSince(this, root, base), described = describe(commits), credited = coAuthors(commits);
			const previous = revising ? saved?.payload : void 0;
			const run = committedRun(this, root, commits, flags);
			const agent = {
				tool: run.tool,
				session: run.session,
				parentSession: run.parentSession
			};
			const payload = {
				title: clip(flags.title ?? previous?.title ?? described.title, 120) || "Agent change",
				summary: clip(flags.summary ?? previous?.summary ?? described.summary, 1200) || "Agent change",
				...flags.intent ?? previous?.intent ? { intent: clip(flags.intent ?? previous?.intent ?? "", 4e3) } : {},
				...flags.rationale ?? previous?.rationale ? { rationale: clip(flags.rationale ?? previous?.rationale ?? "", 6e3) } : {},
				...run.model ? { model: run.model } : {},
				...Object.values(agent).some(Boolean) ? { agent } : {},
				...revising ? { previousRevision: revising.revision } : {},
				...credited.length ? { coAuthors: credited } : {},
				baseCommit: base,
				files: changed,
				...flags.dependsOn !== void 0 ? { dependsOn: flags.dependsOn } : {},
				...flags.tests ? { tests: readTests(this, flags.tests) } : {}
			};
			if (proof) {
				const evidence = await runProof(this, root, proof, braid.secrets);
				if (evidence.length) payload.evidence = evidence;
			}
			assertSubmittable(payload, braid.secrets);
			saved = {
				status: "pending",
				key: randomUUID(),
				target: revising ? `/api/changes/${revising.id}/revisions` : "/api/changes",
				payload
			};
			writeJournal(files, saved);
			noteCommits(this, root, commits, run);
		}
		const pending = saved;
		let change;
		try {
			change = await braid.post(pending.target, pending.payload, change$1, {
				key: pending.key,
				timeout: 18e4
			});
		} catch (error) {
			if (error instanceof ApiError && [
				400,
				403,
				404,
				409,
				413,
				422
			].includes(error.status)) {
				writeJournal(files, {
					...pending,
					status: "rejected"
				});
				fail(`Braid did not accept the change (HTTP ${error.status}): ${error.message}`);
			}
			if (error instanceof CliError) fail(`${error.message} The submission is unconfirmed; resend it exactly with ${command(this, "submit", "--retry")}.`);
			throw error;
		}
		const nextBase = state?.nextBase && state.nextBase !== pending.payload.baseCommit ? state.nextBase : void 0;
		writeState(files, {
			origin: braid.origin,
			workspaceId: braid.credentials.workspaceId,
			base: pending.payload.baseCommit,
			...nextBase ? { nextBase } : {},
			change: {
				id: change.id,
				number: change.number,
				revision: change.revision,
				status: change.status,
				html_url: change.html_url
			}
		});
		writeJournal(files, {
			...pending,
			status: "complete"
		});
		attachActivity(this, root, braid.origin, braid.credentials.workspaceId, change);
		print(this, describeChange(change, braid.secrets) + nextStep(this, change, {
			root,
			origin: braid.origin
		}));
	});
}
function parseDependsOn(value) {
	const parsed = /* @__PURE__ */ safeParse(dependencyFlag, value);
	if (!parsed.success) fail("Use up to 16 pull request numbers or change ids, separated by commas; none clears the dependencies.");
	return parsed.output;
}
const text = (brief, placeholder = "text") => ({
	kind: "parsed",
	parse: String,
	brief,
	placeholder,
	optional: true
});
const submitCommand = buildCommand({
	func: submit$1,
	parameters: { flags: {
		dependsOn: {
			kind: "parsed",
			parse: parseDependsOn,
			brief: "Pull request numbers or ids, comma-separated; none clears dependencies",
			placeholder: "51,52",
			optional: true
		},
		title: text("Title; from the first commit when not given, and kept by later revisions"),
		summary: text("What changed; from the commits when not given"),
		intent: text("Why it was needed"),
		rationale: text("Why it was done this way"),
		model: {
			kind: "parsed",
			parse: parseModel,
			brief: "Model id; from BRAID_MODEL or the coding tool when not given",
			placeholder: "id",
			optional: true
		},
		tool: {
			kind: "parsed",
			parse: parseTool,
			brief: "Tool and version; detected from the processes running braid when not given",
			placeholder: "name",
			optional: true
		},
		session: {
			kind: "parsed",
			parse: parseSession,
			brief: "Session id; from BRAID_SESSION or the coding tool when not given",
			placeholder: "id",
			optional: true
		},
		parentSession: {
			kind: "parsed",
			parse: parseSession,
			brief: "The orchestrator's session; from BRAID_PARENT_SESSION when not given",
			placeholder: "id",
			optional: true
		},
		tests: text("JSON file of up to 10 agent-reported test results: [{command, result, detail?}]", "file"),
		proof: {
			kind: "boolean",
			brief: "Run .braid/proof.json and attach its checks and screenshots",
			optional: true
		},
		retry: {
			kind: "boolean",
			brief: "Resend an unconfirmed submission exactly, with its key",
			optional: true
		},
		push: {
			kind: "boolean",
			brief: "Push the commits and their notes to the braid remote instead of sending files",
			optional: true
		}
	} },
	docs: {
		brief: "Open or revise this branch's change",
		fullDescription: [
			"Sends the committed difference between the branch and its trunk base: a new change the first time, then the next revision of the same change. Commit first; untracked files outside .braid/ must be committed or ignored. Use --push for binary files or submissions larger than the JSON envelope. Artifacts limits individual blobs to 32 MB and each push to about 30 MB. Credential checks run before sending.",
			"",
			"--proof runs .braid/proof.json in the repository and attaches what happened:",
			"  {\"checks\": [\"npm test\", \"npm run build\"], \"timeoutSeconds\": 600,",
			"   \"preview\": {\"command\": \"npm run dev -- --port 4319\", \"url\": \"http://127.0.0.1:4319\", \"pages\": [\"/\", \"/settings\"], \"timeoutSeconds\": 120}}",
			"Up to 10 one-line checks (9 with a preview) run with CI=true and without BRAID_ variables; each one's exit code and the last 8,000 characters of its output are attached even when it fails. The preview must answer on a local port; each page is captured at 1280×800 and 390×844 by a local Playwright (npx playwright install chromium), then the preview is stopped."
		].join("\n")
	}
});
//#endregion
//#region src/stats.ts
const MAX_LINES = 2e4;
const GENERATED = /(?:^|\/)(?:dist|build|vendor)\/|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$|\.lockb?$|\.min\.[^/]+$/i;
/** Select tracked paths with Git's pathspec rules, intersecting the index with the immutable HEAD tree. */
function headFiles(context, root, head, paths) {
	const selected = new Set(git(context, [
		"ls-files",
		"--cached",
		`--with-tree=${head}`,
		"--full-name",
		"-z",
		"--",
		...paths
	], { cwd: paths.length ? context.cwd : root }).toString("utf8").split("\0"));
	return git(context, [
		"ls-tree",
		"-r",
		"-z",
		"--full-tree",
		head
	], { cwd: root }).toString("utf8").split("\0").flatMap((record) => {
		const match = /^(\d+) \S+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
		return match && selected.has(match[3]) ? [{
			mode: match[1],
			object: match[2],
			path: match[3]
		}] : [];
	});
}
/** Attributes are read from HEAD, including nested .gitattributes, rather than from local edits or the index. */
function generatedAttributes(context, root, head, files) {
	const skipped = /* @__PURE__ */ new Set();
	if (!files.length) return skipped;
	const args = [
		"-z",
		"--stdin",
		"linguist-generated",
		"diff"
	], input = `${files.map((file) => file.path).join("\0")}\0`;
	const result = gitTry(context, [
		"check-attr",
		`--source=${head}`,
		...args
	], {
		cwd: root,
		input
	});
	let output = result.stdout;
	if (result.status !== 0) {
		if (result.status !== 129) gitFailed("check-attr", result.stderr, result.status);
		const folder = mkdtempSync(join(tmpdir(), "braid-stats-"));
		const env = {
			...context.env,
			GIT_INDEX_FILE: join(folder, "index")
		};
		try {
			git(context, ["read-tree", head], {
				cwd: root,
				env
			});
			output = git(context, [
				"check-attr",
				"--cached",
				...args
			], {
				cwd: root,
				input,
				env
			});
		} finally {
			rmSync(folder, {
				recursive: true,
				force: true
			});
		}
	}
	const fields = output.toString("utf8").split("\0");
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const [path, attribute, value] = fields.slice(index, index + 3);
		if (attribute === "diff" ? value === "unset" : ![
			"unspecified",
			"unset",
			"false",
			"0"
		].includes(value)) skipped.add(path);
	}
	return skipped;
}
/**
* Inspect each unique HEAD blob in one streaming batch. Keep only line counts, never whole files or binary assets.
* Git's binary heuristic is a NUL in the first 8,000 bytes. Newline counting stops after the line cap is exceeded.
*/
async function scanContents(context, root, objects) {
	const found = /* @__PURE__ */ new Map();
	if (!objects.length) return found;
	const child = spawn("git", ["cat-file", "--batch"], {
		cwd: root,
		env: gitEnv(context.env),
		timeout: 3e5
	});
	let errors = "", header = Buffer.alloc(0), remaining = 0, separator = false, current;
	let size = 0, read = 0, newlines = 0, last = 0, binary = false;
	child.stderr.on("data", (chunk) => {
		errors += chunk.toString("utf8");
	});
	child.stdin.on("error", () => {});
	const closed = new Promise((done, reject) => {
		child.once("error", reject);
		child.once("close", (code) => done(code ?? 1));
	});
	closed.catch(() => {});
	child.stdin.end(`${objects.join("\n")}\n`);
	try {
		for await (const chunk of child.stdout) {
			let offset = 0;
			while (offset < chunk.length) {
				if (separator) {
					separator = false;
					offset++;
					continue;
				}
				if (!current) {
					const end = chunk.indexOf(10, offset);
					if (end < 0) {
						header = Buffer.concat([header, chunk.subarray(offset)]);
						break;
					}
					const match = /^([a-f0-9]+) blob (\d+)$/.exec(Buffer.concat([header, chunk.subarray(offset, end)]).toString("utf8"));
					if (!match) fail("Git did not return a tracked file blob.");
					current = match[1];
					size = remaining = Number(match[2]);
					read = newlines = last = 0;
					binary = false;
					header = Buffer.alloc(0);
					offset = end + 1;
				}
				const count = Math.min(remaining, chunk.length - offset), content = chunk.subarray(offset, offset + count);
				if (!binary && read < 8e3) binary = content.subarray(0, 8e3 - read).includes(0);
				if (!binary && newlines <= MAX_LINES) for (let end = content.indexOf(10); end >= 0 && newlines <= MAX_LINES; end = content.indexOf(10, end + 1)) newlines++;
				if (count) last = content[count - 1];
				read += count;
				remaining -= count;
				offset += count;
				if (!remaining) {
					found.set(current, {
						binary,
						lines: newlines + (size && last !== 10 ? 1 : 0)
					});
					current = void 0;
					separator = true;
				}
			}
		}
		const status = await closed;
		if (status !== 0) gitFailed("cat-file", redact(plain(errors)), status);
		if (found.size !== objects.length) fail("Git did not return all tracked file blobs.");
		return found;
	} finally {
		if (child.exitCode === null) child.kill();
	}
}
/** Incremental blame contains one header per range, without copying the file's text or repeating line metadata. */
function blameCounts(output) {
	const counts = /* @__PURE__ */ new Map();
	for (const match of output.matchAll(/^([a-f0-9]{40}|[a-f0-9]{64}) \d+ \d+ (\d+)$/gm)) counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2]));
	return counts;
}
/**
* Models with the same display name share a row even when one commit names an id and another names the model. A
* person who commits from a GitHub no-reply address and from another address is one owner when their name exactly
* matches a login seen in this history.
*/
function groupStats(counts, known, by, history = []) {
	const grouped = /* @__PURE__ */ new Map();
	const logins = personLogins([...known.values()].map((provenance) => provenance.owner), history);
	for (const [commit, lines] of counts) {
		if (!lines) continue;
		const provenance = known.get(commit);
		if (!provenance) fail(`Git did not return commit ${commit}.`);
		const agent = provenance.agent, owner = personLabel(provenance.owner, logins) || void 0;
		const model = agent?.model ? modelName(agent.model) : void 0;
		const name = model ?? agent?.name ?? "Agent", tool = agent?.tool ? toolBase(agent.tool) : void 0;
		let row;
		if (provenance.kind === "human") row = {
			kind: "human",
			name: "people",
			lines: 0,
			share: 0
		};
		else if (provenance.kind === "bot") row = {
			kind: "bot",
			name: agent?.name ?? "Bot",
			...tool ? { tool } : {},
			lines: 0,
			share: 0
		};
		else if (by === "model") row = {
			kind: "agent",
			name,
			...model ? { model } : {},
			lines: 0,
			share: 0
		};
		else if (by === "owner") row = {
			kind: "agent",
			name: owner ?? "unknown owner",
			...owner ? { owner } : {},
			lines: 0,
			share: 0
		};
		else if (by === "tool") row = {
			kind: "agent",
			name: tool ?? "unknown tool",
			...tool ? { tool } : {},
			lines: 0,
			share: 0
		};
		else row = {
			kind: "agent",
			name: owner ? `${name} for ${owner}` : name,
			...model ? { model } : {},
			...owner ? { owner } : {},
			...tool ? { tool } : {},
			lines: 0,
			share: 0
		};
		const key = JSON.stringify([
			row.kind,
			row.name.toLowerCase(),
			row.owner
		]);
		const previous = grouped.get(key);
		if (previous) {
			previous.lines += lines;
			if (previous.tool !== row.tool) delete previous.tool;
		} else {
			row.lines = lines;
			grouped.set(key, row);
		}
	}
	const total = [...grouped.values()].reduce((sum, row) => sum + row.lines, 0);
	return [...grouped.values()].map((row) => ({
		...row,
		share: total ? row.lines / total : 0
	})).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}
/** Offline, read-only statistics of HEAD. No credentials, network or cache are needed. */
async function collectStats(context, paths = [], options = {}) {
	const root = repositoryRoot(context), head = resolveCommit(context, root, "HEAD");
	const files = headFiles(context, root, head, paths), attributes = generatedAttributes(context, root, head, files);
	const skipped = {
		binary: 0,
		generated: 0,
		large: 0
	};
	const candidates = files.filter((file) => {
		if (GENERATED.test(file.path) || attributes.has(file.path)) {
			skipped.generated++;
			return false;
		}
		if (!REGULAR.has(file.mode)) {
			skipped.binary++;
			return false;
		}
		return true;
	});
	const contents = await scanContents(context, root, [...new Set(candidates.map((file) => file.object))]);
	const counted = candidates.filter((file) => {
		const content = contents.get(file.object);
		if (content.binary) {
			skipped.binary++;
			return false;
		}
		if (content.lines > MAX_LINES) {
			skipped.large++;
			return false;
		}
		return true;
	});
	const counts = /* @__PURE__ */ new Map();
	const byFile = /* @__PURE__ */ new Map();
	let next = 0;
	const workers = Array.from({ length: Math.min(availableParallelism(), counted.length) }, async () => {
		while (next < counted.length) {
			const file = counted[next++];
			if (!contents.get(file.object).lines) continue;
			const attributed = blameCounts((await gitAsync(context, [
				"blame",
				"--incremental",
				head,
				"--",
				file.path
			], root)).toString("utf8"));
			byFile.set(file.path, attributed);
			if ([...attributed.values()].reduce((sum, count) => sum + count, 0) !== contents.get(file.object).lines) fail(`Git did not attribute every line of ${file.path}.`);
			for (const [commit, lines] of attributed) counts.set(commit, (counts.get(commit) ?? 0) + lines);
		}
	});
	const settled = await Promise.allSettled(workers);
	for (const result of settled) if (result.status === "rejected") throw result.reason;
	const facts = readCommits(context, root, [...counts.keys()], options.since);
	const known = new Map(provenances(context, root, [...facts.values()]).map((provenance) => [provenance.commit, provenance]));
	if (options.since) {
		for (const commit of counts.keys()) if (!known.has(commit)) counts.delete(commit);
	}
	const attributedCounts = /* @__PURE__ */ new Map(), attributedKnown = /* @__PURE__ */ new Map();
	for (const [path, linesByCommit] of byFile) for (const [commit, lines] of linesByCommit) {
		if (!counts.has(commit)) continue;
		const provenance = known.get(commit);
		if (!provenance) fail(`Git did not return commit ${commit}.`);
		const key = JSON.stringify([commit, path]);
		attributedCounts.set(key, lines);
		attributedKnown.set(key, fileProvenance(provenance, path));
	}
	const rows = groupStats(attributedCounts, attributedKnown, options.by, await historyLogins(context, root, head));
	return {
		repository: basename(root),
		head,
		files: counted.length,
		lines: rows.reduce((sum, row) => sum + row.lines, 0),
		rows,
		skipped
	};
}
//#endregion
//#region src/commands/stats.ts
function statsTable(result) {
	const skipped = Object.entries(result.skipped).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`);
	return [
		`${plain(result.repository).replace(/\s/g, " ")} · ${count(result.lines, "line")} · ${count(result.files, "file")}`,
		...columns([[
			"Author",
			"Lines",
			"%"
		], ...result.rows.map((row) => [
			row.name,
			row.lines.toLocaleString("en-US"),
			`${(row.share * 100).toFixed(1)}%`
		])]),
		...skipped.length ? [`Skipped: ${skipped.join(", ")}`] : []
	];
}
async function stats(flags, ...paths) {
	const result = await collectStats(this, paths, flags);
	if (flags.json) {
		print(this, JSON.stringify(result, null, 2));
		return;
	}
	for (const row of statsTable(result)) print(this, row);
}
const statsCommand = buildCommand({
	func: stats,
	parameters: {
		flags: {
			since: {
				kind: "parsed",
				parse: String,
				brief: "Only lines last changed by commits after this date, as Git reads it",
				placeholder: "date",
				optional: true
			},
			by: {
				kind: "parsed",
				parse: buildChoiceParser([
					"model",
					"owner",
					"tool"
				]),
				brief: "Group agents by model, owner or tool",
				placeholder: "model|owner|tool",
				optional: true
			},
			json: {
				kind: "boolean",
				brief: "Print repository statistics as JSON",
				optional: true
			}
		},
		positional: {
			kind: "array",
			parameter: {
				brief: "Tracked paths to count, relative to this directory",
				parse: String,
				placeholder: "path"
			}
		}
	},
	docs: { brief: "Count lines by agent, person or bot at HEAD, in any clone" }
});
//#endregion
//#region src/commands/task.ts
const dir = {
	kind: "parsed",
	parse: String,
	brief: "The task checkout; the current directory when not given",
	placeholder: "directory",
	optional: true
};
const required = (brief, placeholder) => ({
	kind: "parsed",
	parse: String,
	brief,
	placeholder
});
const optional = (brief, placeholder = "text") => ({
	kind: "parsed",
	parse: String,
	brief,
	placeholder,
	optional: true
});
const taskRoutes = buildRouteMap({
	routes: {
		start: buildCommand({
			func: async function(flags, link) {
				await startTask(this, {
					link,
					dir: flags.dir
				});
			},
			parameters: {
				flags: { dir: optional("Where to check the task out: this checkout when it is one, else a new braid-<task> directory", "directory") },
				positional: {
					kind: "tuple",
					parameters: [{
						brief: "The task link from Braid",
						parse: String,
						placeholder: "task-link"
					}]
				}
			},
			docs: {
				brief: "Start or return to a task from its link",
				fullDescription: "Reuses the approval for the task's repository, or shows its owner an approval link, then prepares a checkout pinned to the task's base: a clean clone at that base is bound to it, and otherwise a new directory is cloned. Run it again to resume, including after a proposal is in review. Checkouts it prepares submit committed work only."
			}
		}),
		checkout: buildCommand({
			func: async function(flags) {
				await checkoutTask(this, {
					url: flags.url,
					mission: flags.mission,
					agent: flags.agent,
					dir: flags.dir,
					workspace: flags.workspace
				});
			},
			parameters: { flags: {
				url: {
					kind: "parsed",
					parse: normalizeOrigin,
					brief: "Braid address",
					placeholder: "url"
				},
				mission: required("The task id", "id"),
				agent: required("The agent id in the task", "id"),
				dir: required("A new directory to clone into", "directory"),
				workspace: optional("The task's repository id", "id")
			} },
			docs: {
				brief: "Clone one agent's part of a task into a new directory",
				fullDescription: "The older way to check out a task, for tasks with several proposals. Its checkouts submit their working tree, including uncommitted edits."
			}
		}),
		resume: buildCommand({
			func: async function(flags) {
				await resumeTask(this, flags);
			},
			parameters: { flags: { dir } },
			docs: { brief: "Renew this checkout's claim on its task, keeping local work" }
		}),
		update: buildCommand({
			func: async function(flags) {
				await updateTask(this, flags);
			},
			parameters: { flags: { dir } },
			docs: { brief: "Fetch the newer main to integrate, without changing your branch or files" }
		}),
		progress: buildCommand({
			func: async function(flags) {
				await progressTask(this, flags);
			},
			parameters: { flags: {
				dir,
				message: required("A milestone or blocker to share, in one or two sentences", "text")
			} },
			docs: { brief: "Share a milestone or blocker on the task" }
		}),
		submit: buildCommand({
			func: async function(flags) {
				await submitTask(this, flags);
			},
			parameters: { flags: {
				dir,
				dependsOn: {
					kind: "parsed",
					parse: parseDependsOn,
					brief: "Prerequisite pull requests, comma-separated; none clears them",
					placeholder: "51,52",
					optional: true
				},
				summary: optional("What changed; a revision reuses the last summary when left out"),
				rationale: optional("Why it was done this way"),
				model: {
					kind: "parsed",
					parse: parseModel,
					brief: "The model that did the work",
					placeholder: "id",
					optional: true
				},
				tests: optional("JSON file of up to 10 agent-reported test results: [{command, result, detail?}]", "file"),
				proof: {
					kind: "boolean",
					brief: "Run .braid/proof.json and attach its checks and screenshots",
					optional: true
				},
				retry: {
					kind: "boolean",
					brief: "Resend an unconfirmed submission exactly, with its key",
					optional: true
				}
			} },
			docs: {
				brief: "Submit the task's result for review, or revise it",
				fullDescription: "Sends the complete change from the task's base as its proposal; submitting again revises it. The submission is saved with its idempotency key before it is sent, so --retry can resend an unconfirmed one exactly, and identical work replays rather than becoming a new revision. braid submit --help describes .braid/proof.json."
			}
		}),
		wait: buildCommand({
			func: async function(flags) {
				await waitTask(this, flags);
			},
			parameters: { flags: {
				dir,
				timeout: {
					kind: "parsed",
					parse: numberParser,
					brief: "Seconds to wait at most",
					placeholder: "seconds",
					default: "1800"
				}
			} },
			docs: { brief: "Wait until the task's change lands or comes back, then say exactly what to fix" }
		})
	},
	docs: { brief: "Work on a task a person asked for in Braid" }
});
//#endregion
//#region src/commands/credential.ts
/** Braid keeps its own approvals, so Git's `store` and `erase` change nothing. */
async function credential(_flags, operation) {
	const fields = new Map((await this.input()).split("\n").flatMap((line) => {
		const at = line.indexOf("=");
		return at > 0 ? [[line.slice(0, at), line.slice(at + 1).trim()]] : [];
	}));
	if (operation !== "get" || !fields.get("protocol") || !fields.get("host")) return;
	const home = originOf(`${fields.get("protocol")}://${fields.get("host")}`);
	if (!home) return;
	const repository = findRepository(this);
	const linked = [this.env.BRAID_URL, repository?.link?.url].some((url) => !!url && originOf(url) === home);
	if (this.env.BRAID_ACCESS_TOKEN && !linked) return;
	const named = /^git\/(.+)\.git$/.exec(fields.get("path") ?? "")?.[1];
	if (fields.has("path") && !ID.test(named ?? "")) return;
	const workspace = named ?? (linked ? repository?.link?.workspaceId : void 0);
	if (!workspace || this.env.BRAID_WORKSPACE_ID && this.env.BRAID_WORKSPACE_ID !== workspace) return;
	try {
		const credentials = loadCredentials(this, home, workspace);
		print(this, `username=x\npassword=${credentials.accessToken}`);
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		note(this, `braid: ${error.message}`);
	}
}
const credentialCommand = buildCommand({
	func: credential,
	parameters: { positional: {
		kind: "tuple",
		parameters: [{
			brief: "What Git asks: get, store or erase",
			parse: buildChoiceParser([
				"get",
				"store",
				"erase"
			]),
			placeholder: "operation"
		}]
	} },
	docs: { brief: "Git credential helper for the braid remote" }
});
const routes = buildRouteMap({
	routes: {
		login: loginCommand,
		logout: logoutCommand,
		whoami: whoamiCommand,
		init: initCommand,
		restack: restackCommand,
		agent: agentRoutes,
		submit: submitCommand,
		status: statusCommand,
		wait: waitCommand,
		sync: syncCommand,
		task: taskRoutes,
		blame: blameCommand,
		stats: statsCommand,
		log: logCommand,
		instructions: instructionRoutes,
		help: buildCommand({
			func: async function(_flags, ...topic) {
				await run$2(app, [...topic, "--help"], this);
			},
			parameters: { positional: {
				kind: "array",
				parameter: {
					brief: "A command, such as submit or agent run",
					parse: String,
					placeholder: "command"
				}
			} },
			docs: { brief: "Show help for braid or one of its commands" }
		}),
		hook: hookRoutes,
		"git-credential": credentialCommand
	},
	aliases: { connect: "login" },
	docs: {
		brief: "Braid: agents and people changing one repository, with every line traced to who wrote it",
		hideRoute: {
			hook: true,
			"git-credential": true
		}
	}
});
/** Failures braid explains are printed as they are; anything else is a bug, shown without a stack or any secret. */
const failure = (error) => redact(plain(error instanceof CliError ? error.message : `braid failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`));
const formatting = {
	caseStyle: "convert-camel-to-kebab",
	useAliasInUsageLine: false,
	onlyRequiredInUsageLine: false
};
const app = buildApplication(routes, {
	name: "braid",
	scanner: {
		caseStyle: "allow-kebab-for-camel",
		allowArgumentEscapeSequence: true
	},
	localization: { text: {
		...text_en,
		exceptionWhileRunningCommand: failure,
		commandErrorResult: failure
	} }
}, {
	help: help({
		brief: text_en.briefs.help,
		alias: "h",
		defaultForRouteMap: true,
		formatting
	}),
	version: version$1({
		brief: text_en.briefs.version,
		alias: "v",
		info: { currentVersion: version }
	})
});
//#endregion
//#region src/main.ts
if (Number(process.versions.node.split(".")[0]) < 22) {
	process.stderr.write("braid needs Node.js 22 or newer.\n");
	process.exit(1);
}
process.stdout.on("error", (error) => {
	if (error.code === "EPIPE") process.exit(0);
	throw error;
});
const invoked = process.argv[1] ?? "";
let script = "";
try {
	script = realpathSync(invoked);
} catch {}
const onPath = (folder) => (process.env.PATH ?? "").split(delimiter).some((entry) => entry && resolve(entry) === resolve(folder));
/** The commands braid prints start the way braid was started, so an agent can paste them as they are. */
const self = /[\\/]_npx[\\/]/.test(script) ? ["npx", "braid-git"] : basename(invoked) === "braid" && onPath(dirname(invoked)) ? ["braid"] : ["node", script];
const input = async () => {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
};
await run$2(app, process.argv.slice(2), {
	process,
	env: process.env,
	cwd: process.cwd(),
	fetch: globalThis.fetch,
	now: Date.now,
	sleep: (ms) => setTimeout$1(ms),
	signals: process,
	parentPid: process.ppid,
	self,
	script,
	input
});
//#endregion
export {};
