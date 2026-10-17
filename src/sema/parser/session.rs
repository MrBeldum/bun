//! The parts of one text ([`Part`]), parsed one after the other into one file at their offsets in the text. Each part is
//! parsed once; a part that is not wanted is rolled back, so that what a probe or a retry has added is not in the file.

use crate::names::FileAtoms;
use crate::parser::{self, FileLens, file_lens, recycled_file, truncate_file};
use crate::summarize::{PartError, give_back_scratch, sema_parts, take_scratch};
use crate::{Goal, Options, Part, Refused, Scratch};
use bun_sema::hir::{FileBuilder, FileKind, IdList, StmtId};
use bun_sema::resolve::Dialect;
use bun_sema::util::SharedSort;
use core::ops::Range;

/// A text whose parts are being parsed, and the file they go into. There is no JSX, `await` is a keyword, and nothing is
/// recovered from. The file has its own atoms: [`Session::atoms`].
pub struct Session<'t> {
    text: &'t [u8],
    dialect: Dialect,
    /// Given back when the session is dropped.
    scratch: Box<Scratch>,
    /// Recycled when the session is dropped.
    file: Box<FileBuilder>,
    /// The statement of each part kept so far, in order: `FileBuilder::body` is made of them after each part.
    parts: Vec<StmtId>,
    /// The first part says whether the file is JavaScript.
    has_parsed: bool,
}

/// Where a part is in the file: see [`Session::part_at`].
#[derive(Clone, Debug)]
pub struct PartOk {
    /// The one statement of the part.
    pub stmt: StmtId,
    /// The end of the last token of the part, and the end of the token behind it: the last that has been looked at.
    pub end: (u32, u32),
    /// The ids of the comments of the part in `FileBuilder::comments`: those from where the part starts to its end.
    pub comments: Range<u32>,
    /// Likewise in `FileBuilder::diagnostics`.
    pub diagnostics: Range<u32>,
}

/// Where a session was: see [`Session::mark`].
#[derive(Copy, Clone)]
pub struct Mark {
    file: FileLens,
    body: IdList<StmtId>,
    comment_directives: u32,
    parts: u32,
    rare_syntax: u32,
    has_module_syntax: bool,
    may_bind_a_parameter_twice: bool,
}

/// Where the lists that are looked up by a binary search ended before a part: [`SortedLens::sort_since`] sorts what the
/// part appended, as `Parser::source_file` sorts the lists of a whole file once. The ids of a part are all greater than
/// those of the parts before it, so the lists stay sorted as a whole.
#[derive(Copy, Clone)]
struct SortedLens {
    diagnostics: usize,
    body_starts: usize,
    parens: usize,
    jsx_expressions: usize,
    modifiers_of_props: usize,
    import_attributes: usize,
}

impl SortedLens {
    fn of(file: &FileBuilder) -> SortedLens {
        SortedLens {
            diagnostics: file.diagnostics.len(),
            body_starts: file.body_starts.len(),
            parens: file.parens.len(),
            jsx_expressions: file.jsx_expressions.len(),
            modifiers_of_props: file.modifiers_of_props.len(),
            import_attributes: file.import_attributes.len(),
        }
    }

    fn sort_since(self, file: &mut FileBuilder, dialect: Dialect) {
        let diagnostics = &mut file.diagnostics[self.diagnostics..];
        if diagnostics.len() > 1 && dialect == Default::default() {
            diagnostics.shared_sort_by_key(|it| (it.start, it.code));
        }
        let body_starts = &mut file.body_starts[self.body_starts..];
        if !body_starts.is_sorted_by_key(|body| body.0.0) {
            body_starts.shared_sort_unstable_by_key(|body| body.0.0);
        }
        let parens = &mut file.parens[self.parens..];
        if !parens.is_sorted_by_key(|it| it.0.0) {
            parens.shared_sort_by_key(|it| it.0.0);
        }
        let jsx_expressions = &mut file.jsx_expressions[self.jsx_expressions..];
        if !jsx_expressions.is_sorted_by_key(|it| it.0.0) {
            jsx_expressions.shared_sort_unstable_by_key(|it| it.0.0);
        }
        let modifiers_of_props = &mut file.modifiers_of_props[self.modifiers_of_props..];
        if !modifiers_of_props.is_sorted_by_key(|it| it.0.0) {
            modifiers_of_props.shared_sort_unstable_by_key(|it| it.0.0);
        }
        let import_attributes = &mut file.import_attributes[self.import_attributes..];
        if !import_attributes.is_sorted_by_key(|it| it.0) {
            import_attributes.shared_sort_unstable_by_key(|it| it.0);
        }
    }
}

impl<'t> Session<'t> {
    /// Begins a file for the parts of `text`, which are all read in `dialect`.
    pub fn begin(text: &'t [u8], dialect: Dialect) -> Session<'t> {
        let mut scratch = take_scratch();
        // Once for all the parts: `run_part` reads them back with `ScannerStopsBuffer::found`.
        scratch.stops.find(text);
        scratch.names.begin_own(text.len());
        let mut file = scratch.recycled.take().unwrap_or_default();
        *file = recycled_file(&mut file);
        file.source_len = text.len() as u32;
        file.kind = FileKind::Ts;
        Session {
            text,
            dialect,
            scratch,
            file,
            parts: Vec::new(),
            has_parsed: false,
        }
    }

    /// Parses the part of the text from `from` to `until` behind the parts kept so far, and says where it is in the file.
    /// The text ends at `until` for the parser, and what follows the part is not read but one token. `is_javascript`: only
    /// in a JavaScript file is the syntax of TypeScript reported as a `DiagnosticKind::Js`. On an error nothing of the
    /// part stays in the file. What a whole file has sorted once, the part has sorted over what it appended, as the file
    /// is read after each part: see [`SortedLens`].
    pub fn part_at(
        &mut self,
        goal: Goal,
        is_javascript: bool,
        from: u32,
        until: u32,
    ) -> Result<PartOk, PartError> {
        let mark = self.mark();
        if !self.has_parsed {
            self.has_parsed = true;
            self.file.is_js = is_javascript;
        }
        let file = &*self.file;
        let (comments, diagnostics) = (file.comments.len() as u32, file.diagnostics.len() as u32);
        let lens = SortedLens::of(file);
        let options = Options {
            is_javascript,
            dialect: self.dialect,
            attach_comments: true,
            ..Default::default()
        };
        let part = Part { goal, from, until };
        let parsed = match self.run(options, part) {
            Ok(parsed) => parsed,
            Err(refused) if refused.why.is_of_scanner() => {
                // What follows a part need not be a token: then the text ends before it.
                self.rollback(&mark);
                let cut = Part {
                    until: refused.after,
                    ..part
                };
                match self.run(options, cut) {
                    Ok(parsed) => parsed,
                    Err(again) => {
                        self.rollback(&mark);
                        bun_core::scoped_log!(sema_parts, "refused {}..{}", from, until);
                        return Err(PartError::of(&again, refused.after));
                    }
                }
            }
            Err(refused) => {
                self.rollback(&mark);
                bun_core::scoped_log!(sema_parts, "refused {}..{}", from, until);
                return Err(PartError::of(&refused, refused.at));
            }
        };
        self.parts.push(parsed.stmt);
        let file = &mut *self.file;
        lens.sort_since(file, self.dialect);
        file.comment_directives.extend(parsed.comment_directives);
        // `body` is a range of `ids`, which the lists in the part have grown too: it is made anew at the end of `ids` unless
        // it is still there.
        let body = file.body;
        let is_at_end = body.start + body.len == file.ids.len() as u32;
        file.body = match is_at_end && body.len as usize + 1 == self.parts.len() {
            true => {
                file.ids.push(parsed.stmt.0);
                IdList::new(body.start, body.len + 1)
            }
            false => {
                let start = file.ids.len() as u32;
                file.ids.extend(self.parts.iter().map(|it| it.0));
                IdList::new(start, self.parts.len() as u32)
            }
        };
        Ok(PartOk {
            stmt: parsed.stmt,
            end: parsed.end,
            comments: comments..file.comments.len() as u32,
            diagnostics: diagnostics..file.diagnostics.len() as u32,
        })
    }

    /// One run of the parser over `part`. On a refusal the file holds what the part added: the caller rolls it back.
    fn run(&mut self, options: Options, part: Part) -> Result<parser::PartHarvest, Refused> {
        bun_core::scoped_log!(sema_parts, "parse {}..{}", part.from, part.until);
        parser::run_part(self.text, options, part, &mut self.scratch, &mut self.file)
    }

    /// Where the parts kept so far end in the file: [`Session::rollback`] forgets what is parsed after this.
    pub fn mark(&self) -> Mark {
        let file = &*self.file;
        Mark {
            file: file_lens(file),
            body: file.body,
            comment_directives: file.comment_directives.len() as u32,
            parts: self.parts.len() as u32,
            rare_syntax: file.rare_syntax,
            has_module_syntax: file.has_module_syntax,
            may_bind_a_parameter_twice: file.may_bind_a_parameter_twice,
        }
    }

    /// Forgets the parts parsed since `to`: their nodes, comments and diagnostics, as if they had not been parsed.
    pub fn rollback(&mut self, to: &Mark) {
        self.parts.truncate(to.parts as usize);
        let file = &mut *self.file;
        truncate_file(file, &to.file);
        file.comment_directives
            .truncate(to.comment_directives as usize);
        file.body = to.body;
        file.rare_syntax = to.rare_syntax;
        file.has_module_syntax = to.has_module_syntax;
        file.may_bind_a_parameter_twice = to.may_bind_a_parameter_twice;
    }

    /// The file of the parts kept so far, at their offsets in the text. Its `body` is their statements.
    pub fn file(&mut self) -> &mut FileBuilder {
        &mut self.file
    }

    /// The atoms of the file.
    pub fn atoms(&self) -> FileAtoms<'_> {
        Scratch::atoms(&self.scratch, self.text)
    }
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.recycle(std::mem::take(&mut self.file));
        give_back_scratch(scratch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bun_core::strings::index_of;
    use bun_sema::hir::StmtKind;
    use bun_sema_standalone as _;

    const TEXT: &[u8] =
        b"<script>let a = /* one */ 1;\n</script><p>{a /* two */ + b}</p>{#if a}{c(d)}{/if}";

    fn at(needle: &[u8]) -> u32 {
        index_of(TEXT, needle).map_or(u32::MAX, |it| it as u32)
    }

    fn ids(body: IdList<StmtId>, file: &FileBuilder) -> Vec<u32> {
        let range = body.start as usize..(body.start + body.len) as usize;
        file.ids.get(range).unwrap_or_default().to_vec()
    }

    fn kept(session: &mut Session<'_>) -> [PartOk; 3] {
        let len = TEXT.len() as u32;
        let declaration = session.part_at(Goal::Declaration, true, at(b"let a"), len);
        let sum = session.part_at(Goal::Expression, true, at(b"a /*"), len);
        let call = session.part_at(Goal::Expression, true, at(b"c(d)"), len);
        match (declaration, sum, call) {
            (Ok(declaration), Ok(sum), Ok(call)) => [declaration, sum, call],
            (declaration, sum, call) => {
                panic!("a part was refused: {declaration:?} {sum:?} {call:?}")
            }
        }
    }

    #[test]
    fn the_parts_kept_make_one_file_at_their_offsets() {
        let mut session = Session::begin(TEXT, Dialect::default());
        let [declaration, sum, call] = kept(&mut session);
        let file = session.file();
        let body = ids(file.body, file);
        assert_eq!(body, [declaration.stmt.0, sum.stmt.0, call.stmt.0]);
        assert!(declaration.stmt.0 < sum.stmt.0 && sum.stmt.0 < call.stmt.0);
        let kinds: Vec<bool> = body
            .iter()
            .map(|&id| matches!(file.stmts[id as usize].kind, StmtKind::Expr(_)))
            .collect();
        assert_eq!(kinds, [false, true, true]);
        // Every span is one of the whole text.
        assert_eq!(file.stmts[declaration.stmt.idx()].loc.pos, at(b"let a"));
        assert_eq!(file.stmts[sum.stmt.idx()].loc.pos, at(b"a /*"));
        // Without the `;` behind the declarations.
        assert_eq!(declaration.end.0, at(b"1;") + 1);
        assert_eq!(sum.end.0, at(b"+ b}") + 3);
        assert_eq!(call.end.0, at(b"c(d)") + 4);
        assert_eq!(file.source_len, TEXT.len() as u32);
        assert!(file.is_js);
        // Each part has its own comments, and nothing else's.
        let comment_at = |range: &Range<u32>| {
            let comments = &file.comments[range.start as usize..range.end as usize];
            comments.iter().map(|it| it.pos).collect::<Vec<u32>>()
        };
        assert_eq!(comment_at(&declaration.comments), [at(b"/* one */")]);
        assert_eq!(comment_at(&sum.comments), [at(b"/* two */")]);
        assert_eq!(comment_at(&call.comments), []);
        assert!(file.comments.is_sorted_by_key(|it| it.pos));
        assert!(file.diagnostics.is_empty());
        assert!(file.body_starts.is_sorted_by_key(|it| it.0.0));
        assert!(file.parens.is_sorted_by_key(|it| it.0.0));
    }

    #[test]
    fn a_rollback_forgets_the_parts_after_the_mark() {
        let mut session = Session::begin(TEXT, Dialect::default());
        let len = TEXT.len() as u32;
        let first = session.part_at(Goal::Declaration, true, at(b"let a"), len);
        let Ok(first) = first else {
            panic!("refused: {first:?}");
        };
        let mark = session.mark();
        let lens = [
            session.file().stmts.len(),
            session.file().exprs.len(),
            session.file().ids.len(),
        ];
        let comments = session.file().comments.len();
        let sum = session.part_at(Goal::Expression, true, at(b"a /*"), len);
        assert!(sum.is_ok(), "{sum:?}");
        assert_eq!(ids(session.file().body, session.file()).len(), 2);
        session.rollback(&mark);
        let file = session.file();
        assert_eq!(ids(file.body, file), [first.stmt.0]);
        assert_eq!(file.comments.len(), comments);
        assert_eq!([file.stmts.len(), file.exprs.len(), file.ids.len()], lens);
        // The place can be read again, into the same ids.
        let again = session.part_at(Goal::Expression, true, at(b"a /*"), len);
        let Ok(again) = again else {
            panic!("refused: {again:?}");
        };
        assert_eq!(
            ids(session.file().body, session.file()),
            [first.stmt.0, again.stmt.0]
        );
    }

    #[test]
    fn a_refused_part_leaves_nothing_in_the_file() {
        let mut session = Session::begin(TEXT, Dialect::default());
        let len = TEXT.len() as u32;
        let first = session.part_at(Goal::Declaration, true, at(b"let a"), len);
        assert!(first.is_ok(), "{first:?}");
        let lens = [session.file().stmts.len(), session.file().exprs.len()];
        let body = session.file().body;
        // A `{` where an expression has to be: the part is refused.
        let refused = session.part_at(Goal::Expression, true, at(b"{#if"), len);
        assert!(refused.is_err());
        let file = session.file();
        assert_eq!([file.stmts.len(), file.exprs.len()], lens);
        assert_eq!(file.body.start, body.start);
        assert_eq!(file.body.len, body.len);
        assert_eq!(session.parts.len(), 1);
    }
}
