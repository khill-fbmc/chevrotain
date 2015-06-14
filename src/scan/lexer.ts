/// <reference path="../lang/lang_extensions.ts" />
/// <reference path="../scan/tokens.ts" />

module chevrotain.lexer {

    import tok = chevrotain.tokens
    import lang = chevrotain.lang


    var PATTERN = "PATTERN"


    export interface ILexingResult {
        tokens:tok.Token[]
        groups:{ [groupName: string] : tok.Token }
        errors:ILexingError[]
    }

    export interface ILexingError {
        line:number
        column:number
        message:string
    }

    export type TokenConstructor = Function

    /**
     * A RegExp lexer meant to be used for quick prototyping and/or simple grammars.
     * This is NOT meant to be used in commercial compilers/tooling.
     * concerns such as performance/extendability/modularity are ignored in this implementation.
     */
    export class SimpleLexer {

        public static SKIPPED = {
            description: "This marks a skipped Token pattern, this means each token identified by it will" +
                         "be consumed and then throw into oblivion, this can be used to for example: skip whitespace."
        }

        public static NA = /NOT_APPLICIABLE/

        protected allPatterns:RegExp[]
        protected patternIdxToClass:Function[]
        protected patternIdxToGroup:boolean[]
        protected patternIdxToLongerAltIdx:number[]
        protected patternIdxToCanLineTerminator:boolean[]
        protected emptyGroups:{ [groupName: string] : tok.Token }

        /**
         * @param {Function[]} tokenClasses constructor functions for the Tokens types this scanner will support
         *                     These constructors must be in one of three forms:
         *
         *  1. With a PATTERN property that has a RegExp value for tokens to match:
         *     example: -->class Integer extends tok.Token { static PATTERN = /[1-9]\d }<--
         *
         *  2. With a PATTERN property that has a RegExp value AND an IGNORE property with boolean value true.
         *     These tokens will be matched but not as part of the main token vector.
         *     this is usually used for ignoring whitespace/comments
         *     example: -->    class Whitespace extends tok.Token { static PATTERN = /(\t| )/; static IGNORE = true}<--
         *
         *  3. With a PATTERN property that has the value of the var NA define in this module.
         *     This is a convenience form used to avoid matching Token classes that only act as categories.
         *     example: -->class Keyword extends tok.Token { static PATTERN = NA }<--
         *
         *
         *   The following RegExp patterns are not supported:
         *   a. '$' for match at end of input
         *   b. /b global flag
         *   c. /m multi-line flag
         *
         *   The Lexer will identify the first pattern the matches, Therefor the order of Token Constructors passed
         *   To the SimpleLexer's constructor is meaningful. If two patterns may match the same string, the longer one
         *   should be before the shorter one.
         *
         *   Note that there are situations in which we may wish to place the longer pattern after the shorter one.
         *   For example: keywords vs Identifiers.
         *   'do'(/do/) and 'done'(/w+)
         *
         *   * If the Identifier pattern appears before the 'do' pattern both 'do' and 'done'
         *     will be lexed as an Identifier.
         *
         *   * If the 'do' pattern appears before the Identifier pattern 'do' will be lexed correctly as a keyword.
         *     however 'done' will be lexed as TWO tokens keyword 'do' and identifier 'ne'.
         *
         *   To resolve this problem, add a static property on the keyword's Tokens constructor named: LONGER_ALT
         *   example:
         *
         *       export class Identifier extends Keyword { static PATTERN = /[_a-zA-Z][_a-zA-Z0-9]/ }
         *       export class Keyword extends tok.Token {
         *          static PATTERN = lex.NA
         *          static LONGER_ALT = Identifier
         *       }
         *       export class Do extends Keyword { static PATTERN = /do/ }
         *       export class While extends Keyword { static PATTERN = /while/ }
         *       export class Return extends Keyword { static PATTERN = /return/ }
         *
         *   The lexer will then also attempt to match a (longer) Identifier each time a keyword is matched
         *
         *
         */
        constructor(protected tokenClasses:TokenConstructor[]) {
            validatePatterns(tokenClasses)
            var analyzeResult = analyzeTokenClasses(tokenClasses)
            this.allPatterns = analyzeResult.allPatterns
            this.patternIdxToClass = analyzeResult.patternIdxToClass
            this.patternIdxToGroup = analyzeResult.patternIdxToGroup
            this.patternIdxToLongerAltIdx = analyzeResult.patternIdxToLongerAltIdx
            this.patternIdxToCanLineTerminator = analyzeResult.patternIdxToCanLineTerminator
            this.emptyGroups = analyzeResult.emptyGroups
        }

        /**
         * Will lex(Tokenize) a string.
         * Note that this can be called repeatedly on different strings as this method
         * does not modify the state of the Lexer.
         *
         * @param {string} text the string to lex
         * @returns {{tokens: {Token}[], errors: string[]}}
         */
        public tokenize(text:string):ILexingResult {
            var match, i, j, matchAlt, longerAltIdx, matchedImage, imageLength, group, tokClass, newToken,
                canMatchedContainLineTerminator, fixForEndingInLT, c, droppedChar, lastLTIdx, errorMessage, lastCharIsLT
            var orgInput = text
            var offset = 0
            var matchedTokens = []
            var errors:ILexingError[] = []
            var line = 1
            var column = 1
            var groups:any = _.clone(this.emptyGroups)


            while (text.length > 0) {

                match = null
                for (i = 0; i < this.allPatterns.length; i++) {
                    match = this.allPatterns[i].exec(text)
                    if (match !== null) {
                        // even though this pattern matched we must try a another longer alternative.
                        // this can be used to prioritize keywords over identifers
                        longerAltIdx = this.patternIdxToLongerAltIdx[i]
                        if (longerAltIdx) {
                            matchAlt = this.allPatterns[longerAltIdx].exec(text)
                            if (matchAlt && matchAlt[0].length > match[0].length) {
                                match = matchAlt
                                i = longerAltIdx
                            }
                        }
                        break
                    }
                }
                if (match !== null) {
                    matchedImage = match[0]
                    imageLength = matchedImage.length
                    group = this.patternIdxToGroup[i]
                    if (group !== undefined) {
                        tokClass = this.patternIdxToClass[i]
                        newToken = new tokClass(matchedImage, offset, line, column);
                        if (group === "default") {
                            matchedTokens.push(newToken)
                        }
                        else {
                            groups[group].push(newToken)
                        }
                    }
                    text = text.slice(imageLength)
                    offset = offset + imageLength
                    column = column + imageLength // TODO: with newlines the column may change be assigned twice
                    canMatchedContainLineTerminator = this.patternIdxToCanLineTerminator[i]
                    if (canMatchedContainLineTerminator) {
                        var lineTerminatorsInMatch = countLineTerminators(matchedImage)
                        // TODO: identify edge case of one token ending in '\r' and another one starting with '\n'
                        if (lineTerminatorsInMatch !== 0) {
                            line = line + lineTerminatorsInMatch

                            lastLTIdx = imageLength - 1
                            while (lastLTIdx >= 0) {
                                c = matchedImage.charCodeAt(lastLTIdx)
                                // scan in reverse to find last lineTerminator in image
                                if (c === 13 || c === 10) { // '\r' or '\n'
                                    break;
                                }
                                lastLTIdx--
                            }
                            column = imageLength - lastLTIdx

                            if (group !== undefined) { // a none skipped multi line Token, need to update endLine/endColumn
                                lastCharIsLT = lastLTIdx === imageLength - 1
                                fixForEndingInLT = lastCharIsLT ? -1 : 0

                                if (!(lineTerminatorsInMatch === 1 && lastCharIsLT)) {
                                    // if a token ends in a LT that last LT only affects the line numbering of following Tokens
                                    newToken.endLine = line + fixForEndingInLT
                                    // the last LT in a token does not affect the endColumn either as the [columnStart ... columnEnd)
                                    // inclusive to exclusive range.
                                    newToken.endColumn = column - 1 + -fixForEndingInLT
                                }
                                // else single LT in the last character of a token, no need to modify the endLine/EndColumn
                            }
                        }
                    }

                }
                else { // error recovery, drop characters until we identify a valid token's start point
                    var errorStartOffset = offset
                    var errorLine = line
                    var errorColumn = column
                    var foundResyncPoint = false
                    while (!foundResyncPoint && text.length > 0) {
                        // drop chars until we succeed in matching something
                        droppedChar = text.charCodeAt(0)
                        if (droppedChar === 10 || // '\n'
                            (droppedChar === 13 &&
                            (text.length === 1 || (text.length > 1 && text.charCodeAt(1) !== 10)))) { //'\r' not followed by '\n'
                            line++
                            column = 1
                        }
                        else { // this else also matches '\r\n' which is fine, the '\n' will be counted
                            // either when skipping the next char, or when consuming the following pattern
                            // (which will have to start in a '\n' if we manage to consume it)
                            column++
                        }

                        text = text.substr(1)
                        offset++;
                        for (j = 0; j < this.allPatterns.length; j++) {
                            foundResyncPoint = this.allPatterns[j].test(text)
                            if (foundResyncPoint) {
                                break
                            }
                        }
                    }

                    // at this point we either re-synced or reached the end of the input text
                    errorMessage = `unexpected character: ->${orgInput.charAt(errorStartOffset)}<- at offset: ${errorStartOffset},` +
                        ` skipped ${offset - errorStartOffset} characters.`
                    errors.push({line: errorLine, column: errorColumn, message: errorMessage})
                }
            }

            return {tokens: matchedTokens, groups: groups, errors: errors}
        }
    }

    export interface IAnalyzeResult {
        allPatterns: RegExp[]
        patternIdxToClass: Function[]
        patternIdxToGroup : any[]
        patternIdxToLongerAltIdx : number[]
        patternIdxToCanLineTerminator: boolean[]
        emptyGroups: { [groupName: string] : tok.Token }
    }

    export function analyzeTokenClasses(tokenClasses:TokenConstructor[]):IAnalyzeResult {

        var onlyRelevantClasses = _.reject(tokenClasses, (currClass) => {
            return currClass[PATTERN] === SimpleLexer.NA
        })

        var allTransformedPatterns = _.map(onlyRelevantClasses, (currClass) => {
            return addStartOfInput(currClass[PATTERN])
        })

        var allPatternsToClass = _.zipObject(<any>allTransformedPatterns, onlyRelevantClasses)

        var patternIdxToClass:any = _.map(allTransformedPatterns, (pattern) => {
            return allPatternsToClass[pattern.toString()]
        })

        var patternIdxToGroup = _.map(onlyRelevantClasses, (clazz:any) => {
            var groupName = clazz.GROUP
            if (groupName === SimpleLexer.SKIPPED) {
                return undefined
            }
            else if (_.isString(groupName)) {
                return groupName
            }
            else if (_.isUndefined(groupName)) {
                return "default"
            }
            else {
                throw Error("non exhaustive match")
            }
        })

        var patternIdxToLongerAltIdx:any = _.map(onlyRelevantClasses, (clazz:any, idx) => {
            var longerAltClass = clazz.LONGER_ALT

            if (longerAltClass) {
                var longerAltIdx = _.indexOf(onlyRelevantClasses, longerAltClass)
                return longerAltIdx
            }
        })

        var patternIdxToCanLineTerminator = _.map(allTransformedPatterns, (pattern:RegExp) => {
            // TODO: unicode escapes of line terminators too?
            return /\\n|\\r|\\s/g.test(pattern.source)
        })

        var emptyGroups = _.reduce(onlyRelevantClasses, (acc, clazz:any) => {
            var groupName = clazz.GROUP
            if (_.isString(groupName)) {
                acc[groupName] = []
            }
            return acc
        }, {})

        return {
            allPatterns:                   allTransformedPatterns,
            patternIdxToClass:             patternIdxToClass,
            patternIdxToGroup:             patternIdxToGroup,
            patternIdxToLongerAltIdx:      patternIdxToLongerAltIdx,
            patternIdxToCanLineTerminator: patternIdxToCanLineTerminator,
            emptyGroups:                   emptyGroups
        }
    }

    export function validatePatterns(tokenClasses:TokenConstructor[]) {
        var missingErrors = findMissingPatterns(tokenClasses)
        if (!_.isEmpty(missingErrors)) {
            throw new Error(missingErrors.join("\n ---------------- \n"))
        }

        var invalidPatterns = findInvalidPatterns(tokenClasses)
        if (!_.isEmpty(invalidPatterns)) {
            throw new Error(invalidPatterns.join("\n ---------------- \n"))
        }

        var InvalidEndOfInputAnchor = findEndOfInputAnchor(tokenClasses)
        if (!_.isEmpty(InvalidEndOfInputAnchor)) {
            throw new Error(InvalidEndOfInputAnchor.join("\n ---------------- \n"))
        }

        var invalidFlags = findUnsupportedFlags(tokenClasses)
        if (!_.isEmpty(invalidFlags)) {
            throw new Error(invalidFlags.join("\n ---------------- \n"))
        }

        var duplicates = findDuplicatePatterns(tokenClasses)
        if (!_.isEmpty(duplicates)) {
            throw new Error(invalidFlags.join("\n ---------------- \n"))
        }

        var invalidGroupType = findInvalidGroupType(tokenClasses)

        if (!_.isEmpty(invalidGroupType)) {
            throw new Error(invalidGroupType.join("\n ---------------- \n"))
        }
    }

    export function findMissingPatterns(tokenClasses:TokenConstructor[]):string[] {
        var noPatternClasses = _.filter(tokenClasses, (currClass) => {
            return !_.has(currClass, PATTERN)
        })

        var errors = _.map(noPatternClasses, (currClass) => {
            return "Token class: ->" + tok.tokenName(currClass) + "<- missing static 'PATTERN' property"
        })

        return errors
    }

    export function findInvalidPatterns(tokenClasses:TokenConstructor[]):string[] {
        var invalidRegex = _.filter(tokenClasses, (currClass) => {
            var pattern = currClass[PATTERN]
            return !_.isRegExp(pattern)
        })

        var errors = _.map(invalidRegex, (currClass) => {
            return "Token class: ->" + tok.tokenName(currClass) + "<- static 'PATTERN' can only be a RegEx"
        })

        return errors
    }

    var end_of_input = /[^\\][\$]/

    export function findEndOfInputAnchor(tokenClasses:TokenConstructor[]):string[] {
        var invalidRegex = _.filter(tokenClasses, (currClass) => {
            var pattern = currClass[PATTERN]
            return end_of_input.test(pattern.source)
        })

        var errors = _.map(invalidRegex, (currClass) => {
            return "Token class: ->" + tok.tokenName(currClass) + "<- static 'PATTERN' cannot contain end of input anchor '$'"
        })

        return errors
    }

    export function findUnsupportedFlags(tokenClasses:TokenConstructor[]):string[] {
        var invalidFlags = _.filter(tokenClasses, (currClass) => {
            var pattern = currClass[PATTERN]
            return pattern instanceof RegExp && (pattern.multiline || pattern.global)
        })

        var errors = _.map(invalidFlags, (currClass) => {
            return "Token class: ->" + tok.tokenName(currClass) + "<- static 'PATTERN' may NOT contain global('g') or multiline('m')"
        })

        return errors
    }

    // This can only test for identical duplicate RegExps, not semantically equivalent ones.
    export function findDuplicatePatterns(tokenClasses:TokenConstructor[]):string[] {

        var found = []
        var identicalPatterns = _.map(tokenClasses, (outerClass:any) => {
            return _.reduce(tokenClasses, (result, innerClass:any) => {
                if ((outerClass.PATTERN.source === innerClass.PATTERN.source) && !_.contains(found, innerClass)) {
                    // this avoids duplicates in the result, each class may only appear in one "set"
                    // in essence we are creating Equivalence classes on equality relation.
                    found.push(innerClass)
                    return _.union(result, [innerClass])
                }
            }, [])
        })

        identicalPatterns = _.compact(identicalPatterns)

        var duplicatePatterns = _.filter(identicalPatterns, (currIdenticalSet) => {
            return _.size(currIdenticalSet) > 1
        })

        var errors = _.map(duplicatePatterns, (setOfIdentical:any) => {
            var classNames = _.map(setOfIdentical, (currClass:any) => {
                return tok.tokenName(currClass)
            })

            var dupPatternSrc = (<any>_.first(setOfIdentical)).PATTERN
            return `The same RegExp pattern ->${dupPatternSrc}<-` +
                `has been used in all the following classes: ${classNames.join(", ")} <-`
        })

        return errors
    }


    export function findInvalidGroupType(tokenClasses:TokenConstructor[]):string[] {

        var invalidTypes = _.filter(tokenClasses, (clazz:any) => {
            if (!_.has(clazz, "GROUP")) {
                return false
            }
            var group = clazz.GROUP

            return group !== SimpleLexer.SKIPPED &&
                group !== SimpleLexer.NA && !_.isString(group)
        })


        var errors = _.map(invalidTypes, (currClass) => {
            return "Token class: ->" + tok.tokenName(currClass) + "<- static 'GROUP' can only be Lexer.SKIPPED/Lexer.NA/A String"
        })

        return errors
    }


    export function addStartOfInput(pattern:RegExp):RegExp {
        var flags = pattern.ignoreCase ? "i" : ""
        // always wrapping in a none capturing group preceded by '^' to make sure matching can only work on start of input.
        // duplicate/redundant start of input markers have no meaning (/^^^^A/ === /^A/)
        return new RegExp(`^(?:${pattern.source})`, flags)
    }

    export function countLineTerminators(text:string):number {
        var lineTerminators = 0
        var currOffset = 0

        while (currOffset < text.length) {
            var c = text.charCodeAt(currOffset)
            if (c === 10) { // "\n"
                lineTerminators++
            }
            else if (c === 13) { // \r
                if (currOffset !== text.length - 1 &&
                    text.charCodeAt(currOffset + 1) === 10) { // "\n"
                }
                else {
                    lineTerminators++
                }
            }

            currOffset++
        }

        return lineTerminators
    }
}

