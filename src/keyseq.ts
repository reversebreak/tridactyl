/** Key-sequence parser

    If `map` is a Map of `MinimalKey[]` to objects (exstrs or callbacks)
    and `keyseq` is an array of [[MinimalKey]] compatible objects...

     - `parse(keyseq, map)` returns the mapped object and a count OR a prefix
       of `MinimalKey[]` (possibly empty) that, if more keys are pressed, could
       map to an object.
     - `completions(keyseq, map)` returns the fragment of `map` that keyseq is
       a valid prefix of.
     - `mapstrToKeySeq` generates KeySequences for the rest of the API.

    No key sequence in a `map` may be a prefix of another key sequence in that
    map. This is a point of difference from Vim that removes any time-dependence
    in the parser. Vimperator, Pentadactyl, saka-key, etc, all share this
    limitation.

    If a key is represented by a single character then the shift modifier state
    is ignored unless other modifiers are also present.

*/

/** */
import { find, filter, izip } from "./itertools"
import { Parser } from "./nearley_utils"
import * as bracketexpr_grammar from "./grammars/.bracketexpr.generated"
const bracketexpr_parser = new Parser(bracketexpr_grammar)

// {{{ General types

export type KeyModifiers = {
    altKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    shiftKey?: boolean
}

export class MinimalKey {
    readonly altKey = false
    readonly ctrlKey = false
    readonly metaKey = false
    readonly shiftKey = false

    constructor(readonly key: string, modifiers?: KeyModifiers) {
        for (let mod in modifiers) {
            this[mod] = modifiers[mod]
        }
    }

    /** Does this key match a given MinimalKey extending object? */
    public match(keyevent) {
        // 'in' doesn't include prototypes, so it's safe for this object.
        for (let attr in this) {
            // Don't check shiftKey for normal keys.
            if (attr === "shiftKey" && this.key.length === 1) continue
            if (this[attr] !== keyevent[attr]) return false
        }
        return true
    }

    public toMapstr() {
        let str = ""
        let needsBrackets = this.key.length > 1

        // Format modifiers
        const modifiers = new Map([
            ["A", "altKey"],
            ["C", "ctrlKey"],
            ["M", "metaKey"],
            ["S", "shiftKey"],
        ])
        for (const [letter, attr] of modifiers.entries()) {
            if (this[attr]) {
                str += letter
                needsBrackets = true
            }
        }
        if (str) {
            str += "-"
        }

        // Format the rest
        str += this.key
        if (needsBrackets) {
            str = "<" + str + ">"
        }

        return str
    }
}

import { MsgSafeKeyboardEvent } from "./msgsafe"

type KeyEventLike = MinimalKey | MsgSafeKeyboardEvent | KeyboardEvent

// }}}

// {{{ parser and completions

type MapTarget = string | Function
type KeyMap = Map<MinimalKey[], MapTarget>

export type ParserResponse = {
    keys?: KeyEventLike[]
    value?: any
    exstr?: any
    isMatch: boolean
}

export function parse(keyseq: KeyEventLike[], map: KeyMap): ParserResponse {
    // Remove bare modifiers
    keyseq = keyseq.filter(
        key =>
            !["Control", "Shift", "Alt", "AltGraph", "Meta"].includes(key.key),
    )

    // If keyseq is a prefix of a key in map, proceed, else try dropping keys
    // from keyseq until it is empty or is a prefix.
    let possibleMappings = completions(keyseq, map)
    while (possibleMappings.size === 0 && keyseq.length > 0) {
        keyseq.shift()
        possibleMappings = completions(keyseq, map)
    }

    if (possibleMappings.size > 0) {
        // Check if any of the mappings is a perfect match (this will only
        // happen if some sequences in the KeyMap are prefixes of other seqs).
        try {
            let perfect = find(
                possibleMappings,
                ([k, v]) => k.length === keyseq.length,
            )
            return { value: perfect[1], exstr: perfect[1], isMatch: true }
        } catch (e) {
            if (!(e instanceof RangeError)) throw e
        }
    }
    return { keys: keyseq, isMatch: keyseq.length > 0 }
}

/** True if seq1 is a prefix or equal to seq2 */
function prefixes(seq1: KeyEventLike[], seq2: MinimalKey[]) {
    if (seq1.length > seq2.length) {
        return false
    } else {
        for (const [key1, key2] of izip(seq1, seq2)) {
            if (!key2.match(key1)) return false
        }
        return true
    }
}

/** returns the fragment of `map` that keyseq is a valid prefix of. */
export function completions(keyseq: KeyEventLike[], map: KeyMap): KeyMap {
    return new Map(
        filter(map.entries(), ([ks, maptarget]) => prefixes(keyseq, ks)),
    )
}

// }}}

// {{{ mapStrToKeySeq stuff

/** Expand special key aliases that Vim provides to canonical values

    Vim aliases are case insensitive.
*/
function expandAliases(key: string) {
    // Vim compatibility aliases
    const aliases = {
        cr: "Enter",
        esc: "Escape",
        return: "Enter",
        enter: "Enter",
        space: " ",
        bar: "|",
        del: "Delete",
        bs: "Backspace",
        lt: "<",
    }
    if (key.toLowerCase() in aliases) return aliases[key.toLowerCase()]
    else return key
}

/** String starting with a `<` to MinimalKey and remainder.

    Bracket expressions generally start with a `<` contain no angle brackets or
    whitespace and end with a `>.` These special-cased expressions are also
    permitted: `<{modifier}<>`, `<{modifier}>>`, and `<{modifier}->`.

    If the string passed does not match this definition, it is treated as a
    literal `<.`

    Backus Naur approximation:

    ```
        - bracketexpr ::= '<' modifier? key '>'
        - modifier ::= 'm'|'s'|'a'|'c' '-'
        - key ::= '<'|'>'|/[^\s<>-]+/
    ```

    See `src/grammars/bracketExpr.ne` for the canonical definition.

    Modifiers are case insensitive.

    Some case insensitive vim compatibility aliases are also defined, see
    [[expandAliases]].

    Compatibility breaks:

    Shift + key must use the correct capitalisation of key:
        `<S-j> != J, <S-J> == J`.

    In Vim `<A-x> == <M-x>` on most systems. Not so here: we can't detect
    platform, so just have to use what the browser gives us.

    Vim has a predefined list of special key sequences, we don't: there are too
    many (and they're non-standard) [1].

    In the future, we may just use the names as defined in keyNameList.h [2].

    In Vim, you're still allowed to use `<lt>` within angled brackets:
        `<M-<> == <M-lt> == <M-<lt>>`
    Here only the first two will work.

    Restrictions:

    It is not possible to map to a keyevent that actually sends the key value
    of any of the aliases or to any multi-character sequence containing a space
    or `>.` It is unlikely that browsers will ever do either of those things.

    [1]: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values
    [2]: https://searchfox.org/mozilla-central/source/dom/events/KeyNameList.h

*/
export function bracketexprToKey(inputStr) {
    if (inputStr.indexOf(">") > 0) {
        try {
            const [
                [modifiers, key],
                remainder,
            ] = bracketexpr_parser.feedUntilError(inputStr)
            return [new MinimalKey(expandAliases(key), modifiers), remainder]
        } catch (e) {
            // No valid bracketExpr
            return [new MinimalKey("<"), inputStr.slice(1)]
        }
    } else {
        // No end bracket to match == no valid bracketExpr
        return [new MinimalKey("<"), inputStr.slice(1)]
    }
}

/** Generate KeySequences for the rest of the API.

    A map expression is something like:

    ```
    j scrollline 10
    <C-f> scrollpage 0.5
    <C-d> scrollpage 0.5
    <C-/><C-n> mode normal
    ```

    A mapstr is the bit before the space.

    mapstrToKeyseq turns a mapstr into a keySequence that looks like this:

    ```
    [MinimalKey {key: 'j'}]
    [MinimalKey {key: 'f', ctrlKey: true}]
    [MinimalKey {key: 'd', ctrlKey: true}]
    [MinimalKey {key: '/', ctrlKey: true}, MinimalKey {key: 'n', ctrlKey: true}]
    ```

    (All four {modifier}Key flags are actually provided on all MinimalKeys)
*/
export function mapstrToKeyseq(mapstr: string): MinimalKey[] {
    const keyseq: MinimalKey[] = []
    let key: MinimalKey
    // Reduce mapstr by one character or one bracket expression per iteration
    while (mapstr.length) {
        if (mapstr[0] === "<") {
            ;[key, mapstr] = bracketexprToKey(mapstr)
            keyseq.push(key)
        } else {
            keyseq.push(new MinimalKey(mapstr[0]))
            mapstr = mapstr.slice(1)
        }
    }
    return keyseq
}

/** Convert a map of mapstrs (e.g. from config) to a KeyMap */
export function mapstrMapToKeyMap(mapstrMap: Map<string, MapTarget>): KeyMap {
    const newKeyMap = new Map()
    for (const [mapstr, target] of mapstrMap.entries()) {
        newKeyMap.set(mapstrToKeyseq(mapstr), target)
    }
    return newKeyMap
}

export function mapstrObjToKeyMap(mapstrObj): KeyMap {
    const mapstrMap = new Map(Object.entries(mapstrObj))
    return mapstrMapToKeyMap(mapstrMap)
}

// }}}

// {{{ Utility functions for dealing with KeyboardEvents

export function hasModifiers(keyEvent: KeyEventLike) {
    return (
        keyEvent.ctrlKey ||
        keyEvent.altKey ||
        keyEvent.metaKey ||
        keyEvent.shiftKey
    )
}

/** shiftKey is true for any capital letter, most numbers, etc. Generally care about other modifiers. */
export function hasNonShiftModifiers(keyEvent: KeyEventLike) {
    return keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey
}

/** A simple key event is a non-special key (length 1) that is not modified by ctrl, alt, or shift. */
export function isSimpleKey(keyEvent: KeyEventLike) {
    return !(keyEvent.key.length > 1 || hasNonShiftModifiers(keyEvent))
}

// }}}
