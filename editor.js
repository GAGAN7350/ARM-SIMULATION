// ============================================================
//  Editor setup — CodeMirror 5 with RISC-V assembly mode
// ============================================================

// Define a simple RISC-V assembly mode for CodeMirror
CodeMirror.defineMode('riscv', function() {
    const MNEMONICS = new Set([
        // R-type
        'add','sub','sll','slt','sltu','xor','srl','sra','or','and',
        // I-type
        'addi','slti','sltiu','xori','ori','andi','slli','srli','srai',
        // U-type
        'lui','auipc',
        // Loads
        'lb','lh','lw','lbu','lhu',
        // Stores
        'sb','sh','sw',
        // Branches
        'beq','bne','blt','bge','bltu','bgeu',
        // Jumps
        'jal','jalr',
        // System
        'ecall','ebreak',
        // Pseudos
        'nop','mv','li','la','ret','j','jr','call',
        'neg','not','seqz','snez','sltz','sgtz',
        'beqz','bnez','bltz','bgtz','bgez','blez','ble','bgt','bleu','bgtu',
    ]);

    const REGS = new Set([
        'zero','ra','sp','gp','tp',
        't0','t1','t2','t3','t4','t5','t6',
        's0','s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11',
        'a0','a1','a2','a3','a4','a5','a6','a7','fp',
        ...Array.from({length:32}, (_,i) => `x${i}`)
    ]);

    const DIRECTIVES = new Set(['.text','.data','.word','.half','.byte','.string','.asciz','.ascii','.globl','.align','.equ']);

    return {
        startState() { return { inString: false }; },
        token(stream, state) {
            if (stream.eatSpace()) return null;

            // Comment
            if (stream.peek() === '#' || stream.peek() === ';') {
                stream.skipToEnd();
                return 'comment';
            }

            // String
            if (stream.peek() === '"') {
                stream.next();
                while (!stream.eol()) {
                    const ch = stream.next();
                    if (ch === '\\') stream.next();
                    else if (ch === '"') break;
                }
                return 'string';
            }

            // Hex / binary / decimal number
            if (stream.match(/^0x[0-9a-fA-F]+/)) return 'number';
            if (stream.match(/^0b[01]+/))         return 'number';
            if (stream.match(/^-?\d+/))            return 'number';

            // Label definition
            if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*:/)) return 'def';

            // Word token
            const word = stream.match(/^[a-zA-Z_.][a-zA-Z0-9_.]*/);
            if (word) {
                const tok = word[0].toLowerCase();
                if (MNEMONICS.has(tok)) return 'keyword';
                if (REGS.has(tok))      return 'variable-2';
                if (DIRECTIVES.has(tok))return 'meta';
                return 'atom';
            }

            // Punctuation
            stream.next();
            return null;
        }
    };
});

// ─── Create editor instance ────────────────────────────────
function createEditor(textareaId) {
    const textarea = document.getElementById(textareaId);
    const editor = CodeMirror.fromTextArea(textarea, {
        mode: 'riscv',
        theme: 'riscv-dark',
        lineNumbers: true,
        matchBrackets: true,
        autoCloseBrackets: false,
        indentWithTabs: true,
        tabSize: 8,
        lineWrapping: false,
        gutters: ['CodeMirror-linenumbers', 'cm-breakpoints'],
        extraKeys: {
            'Tab': cm => cm.execCommand('insertTab'),
        }
    });

    // Allow resizing
    editor.setSize('100%', '100%');
    return editor;
}

// ─── Highlight a specific line in the editor (PC indicator) ─
let currentHighlight = null;
function highlightLine(editor, lineNum) {
    if (currentHighlight !== null) {
        editor.removeLineClass(currentHighlight, 'wrap', 'cm-active-line');
    }
    if (lineNum >= 0 && lineNum < editor.lineCount()) {
        editor.addLineClass(lineNum, 'wrap', 'cm-active-line');
        editor.scrollIntoView({ line: lineNum, ch: 0 }, 100);
        currentHighlight = lineNum;
    }
}

// ─── Clear PC highlight ────────────────────────────────────
function clearHighlight(editor) {
    if (currentHighlight !== null) {
        editor.removeLineClass(currentHighlight, 'wrap', 'cm-active-line');
        currentHighlight = null;
    }
}
