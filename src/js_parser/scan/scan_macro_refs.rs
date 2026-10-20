//! Where the statements that the visit pass left still name a macro import. `P::reject_macro_value_uses` decides from
//! the use counts that one is left, and only then asks this for the place to report.

use bun_ast::expr::Data;
use bun_ast::stmt::Data as StmtData;
use bun_ast::{self as ast, Expr, G, Loc, Ref, Stmt, StmtOrExpr, b::B};
use bun_collections::VecExt as _;

use crate::parser::MacroRefs;

/// Fits the smallest stack this runs on, as `function_identities::MAX_DEPTH` does.
const MAX_DEPTH: u32 = 512;

struct Locator<'r, 'a> {
    refs: &'r MacroRefs<'a>,
    found: Vec<(Ref, Loc)>,
    depth: u32,
    stack_check: bun_core::StackCheck,
}

/// Each identifier that names a key of `refs`, in source order. What is nested deeper than `MAX_DEPTH` is not in it.
#[cold]
#[inline(never)]
pub(crate) fn locate_macro_refs(parts: [&[ast::Part]; 3], refs: &MacroRefs<'_>) -> Vec<(Ref, Loc)> {
    let mut locator = Locator {
        refs,
        found: Vec::new(),
        depth: 0,
        stack_check: bun_core::StackCheck::init(),
    };
    for part in parts.into_iter().flatten() {
        locator.stmts(part.stmts.slice());
    }
    let mut found = locator.found;
    found.sort_by_key(|(_, loc)| loc.start);
    found
}

impl Locator<'_, '_> {
    fn name(&mut self, r#ref: Ref, loc: Loc) {
        if self.refs.contains_key(&r#ref) {
            self.found.push((r#ref, loc));
        }
    }

    /// Every `enter` that says yes is followed by a `leave`.
    fn enter(&mut self) -> bool {
        if self.depth >= MAX_DEPTH || !self.stack_check.is_safe_to_recurse() {
            return false;
        }
        self.depth += 1;
        true
    }

    #[inline]
    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn optional_expr(&mut self, expr: Option<&Expr>) {
        if let Some(expr) = expr {
            self.expr(expr);
        }
    }

    fn exprs(&mut self, exprs: &[Expr]) {
        for expr in exprs {
            self.expr(expr);
        }
    }

    fn stmts(&mut self, stmts: &[Stmt]) {
        for stmt in stmts {
            self.stmt(stmt);
        }
    }

    fn binding(&mut self, binding: &ast::Binding) {
        if !self.enter() {
            return;
        }
        match &binding.data {
            B::BIdentifier(_) | B::BMissing(_) => {}
            B::BArray(array) => {
                for item in array.items() {
                    self.binding(&item.binding);
                    self.optional_expr(item.default_value.as_ref());
                }
            }
            B::BObject(object) => {
                for property in object.properties() {
                    self.expr(&property.key);
                    self.binding(&property.value);
                    self.optional_expr(property.default_value.as_ref());
                }
            }
        }
        self.leave();
    }

    fn args(&mut self, args: &[G::Arg]) {
        for arg in args {
            self.exprs(arg.ts_decorators.slice());
            self.binding(&arg.binding);
            self.optional_expr(arg.default.as_ref());
        }
    }

    fn func(&mut self, func: &G::Fn) {
        self.args(func.args.slice());
        self.stmts(func.body.stmts.slice());
    }

    fn properties(&mut self, properties: &[G::Property]) {
        for property in properties {
            if let Some(block) = property.class_static_block_ref() {
                self.stmts(block.stmts.as_slice());
            }
            self.exprs(property.ts_decorators.slice());
            self.optional_expr(property.key.as_ref());
            self.optional_expr(property.value.as_ref());
            self.optional_expr(property.initializer.as_ref());
        }
    }

    fn class(&mut self, class: &G::Class) {
        self.exprs(class.ts_decorators.slice());
        self.optional_expr(class.extends.as_ref());
        self.properties(class.properties.slice());
    }

    fn stmt(&mut self, stmt: &Stmt) {
        if self.enter() {
            self.stmt_at_depth(stmt);
            self.leave();
        }
    }

    fn stmt_at_depth(&mut self, stmt: &Stmt) {
        // `else if` after `else if` is as deep as it is long.
        let mut stmt = stmt;
        while let StmtData::SIf(s) = &stmt.data {
            self.expr(&s.test);
            self.stmt(&s.yes);
            match &s.no {
                Some(no) => stmt = no,
                None => return,
            }
        }
        match &stmt.data {
            StmtData::SIf(_) => unreachable!("the loop above ends at what is not one"),
            StmtData::SBlock(s) => self.stmts(s.stmts.slice()),
            StmtData::SExpr(s) => self.expr(&s.value),
            StmtData::SLocal(s) => {
                for decl in s.decls.iter() {
                    self.binding(&decl.binding);
                    self.optional_expr(decl.value.as_ref());
                }
            }
            StmtData::SReturn(s) => self.optional_expr(s.value.as_ref()),
            StmtData::SThrow(s) => self.expr(&s.value),
            StmtData::SFor(s) => {
                if let Some(init) = &s.init {
                    self.stmt(init);
                }
                self.optional_expr(s.test.as_ref());
                self.optional_expr(s.update.as_ref());
                self.stmt(&s.body);
            }
            StmtData::SForIn(s) => {
                self.stmt(&s.init);
                self.expr(&s.value);
                self.stmt(&s.body);
            }
            StmtData::SForOf(s) => {
                self.stmt(&s.init);
                self.expr(&s.value);
                self.stmt(&s.body);
            }
            StmtData::SWhile(s) => {
                self.expr(&s.test);
                self.stmt(&s.body);
            }
            StmtData::SDoWhile(s) => {
                self.stmt(&s.body);
                self.expr(&s.test);
            }
            StmtData::SSwitch(s) => {
                self.expr(&s.test);
                for case in s.cases.slice() {
                    self.optional_expr(case.value.as_ref());
                    self.stmts(case.body.slice());
                }
            }
            StmtData::STry(s) => {
                self.stmts(s.body.slice());
                if let Some(catch) = &s.catch {
                    if let Some(binding) = &catch.binding {
                        self.binding(binding);
                    }
                    self.stmts(catch.body.slice());
                }
                if let Some(finally) = &s.finally {
                    self.stmts(finally.stmts.slice());
                }
            }
            StmtData::SLabel(s) => self.stmt(&s.stmt),
            StmtData::SWith(s) => {
                self.expr(&s.value);
                self.stmt(&s.body);
            }
            StmtData::SFunction(s) => self.func(&s.func),
            StmtData::SClass(s) => self.class(&s.class),
            StmtData::SExportDefault(s) => match &s.value {
                StmtOrExpr::Stmt(stmt) => self.stmt(stmt),
                StmtOrExpr::Expr(expr) => self.expr(expr),
            },
            StmtData::SExportEquals(s) => self.expr(&s.value),
            StmtData::SExportClause(s) => {
                for item in s.items.slice() {
                    self.name(item.name.ref_, item.name.loc);
                }
            }
            StmtData::SEnum(s) => {
                for value in s.values.slice() {
                    self.optional_expr(value.value.as_ref());
                }
            }
            StmtData::SNamespace(s) => self.stmts(s.stmts.slice()),
            StmtData::SBreak(_)
            | StmtData::SComment(_)
            | StmtData::SContinue(_)
            | StmtData::SDebugger(_)
            | StmtData::SDirective(_)
            | StmtData::SEmpty(_)
            | StmtData::SExportFrom(_)
            | StmtData::SExportStar(_)
            | StmtData::SImport(_)
            | StmtData::SLazyExport(_)
            | StmtData::STypeScript(_) => {}
        }
    }

    fn expr(&mut self, expr: &Expr) {
        if self.enter() {
            self.expr_at_depth(expr);
            self.leave();
        }
    }

    fn expr_at_depth(&mut self, expr: &Expr) {
        // A long `a + b + c + ...` is as deep to the left as it is long, and `a.b().c()...` at its target.
        let mut expr = expr;
        loop {
            expr = match &expr.data {
                Data::EBinary(e) => {
                    self.expr(&e.right);
                    &e.left
                }
                Data::EDot(e) => &e.target,
                Data::EIndex(e) => {
                    self.expr(&e.index);
                    &e.target
                }
                Data::ECall(e) => {
                    self.exprs(e.args.slice());
                    &e.target
                }
                _ => break,
            };
        }
        match &expr.data {
            Data::EBinary(_) | Data::EDot(_) | Data::EIndex(_) | Data::ECall(_) => {
                unreachable!("the loop above ends at what is none of these")
            }
            Data::EIdentifier(e) => self.name(e.ref_, expr.loc),
            Data::EImportIdentifier(e) => self.name(e.ref_, expr.loc),
            Data::EUnary(e) => self.expr(&e.value),
            Data::ENew(e) => {
                self.expr(&e.target);
                self.exprs(e.args.slice());
            }
            Data::EArrow(e) => {
                self.args(e.args.slice());
                self.stmts(e.body.stmts.slice());
            }
            Data::EFunction(e) => self.func(&e.func),
            Data::EClass(e) => self.class(e),
            Data::EArray(e) => self.exprs(e.items.slice()),
            Data::EObject(e) => self.properties(e.properties.slice()),
            Data::EJsxElement(e) => {
                self.optional_expr(e.tag.as_ref());
                self.properties(e.properties.slice());
                self.exprs(e.children.slice());
            }
            Data::ESpread(e) => self.expr(&e.value),
            Data::EIf(e) => {
                // `a ? b : c ? d : ...` is as deep to the right as it is long.
                let mut e = e;
                loop {
                    self.expr(&e.test);
                    self.expr(&e.yes);
                    match &e.no.data {
                        Data::EIf(no) => e = no,
                        _ => break self.expr(&e.no),
                    }
                }
            }
            Data::EImport(e) => {
                self.expr(&e.expr);
                self.expr(&e.options);
            }
            Data::EAwait(e) => self.expr(&e.value),
            Data::EYield(e) => self.optional_expr(e.value.as_ref()),
            Data::ETemplate(e) => {
                self.optional_expr(e.tag.as_ref());
                for part in e.parts() {
                    self.expr(&part.value);
                }
            }
            Data::EInlinedEnum(e) => self.expr(&e.value),
            Data::EArrayJSON(_)
            | Data::EBigInt(_)
            | Data::EBoolean(_)
            | Data::EBranchBoolean(_)
            | Data::ECommonjsExportIdentifier(_)
            | Data::EImportMeta(_)
            | Data::EImportMetaMain(_)
            | Data::EMissing(_)
            | Data::ENameOfSymbol(_)
            | Data::ENewTarget(_)
            | Data::ENull(_)
            | Data::ENumber(_)
            | Data::EObjectJSON(_)
            | Data::EPrivateIdentifier(_)
            | Data::ERegExp(_)
            | Data::ERequireCallTarget
            | Data::ERequireMain
            | Data::ERequireResolveCallTarget
            | Data::ERequireResolveString(_)
            | Data::ERequireString(_)
            | Data::ESpecial(_)
            | Data::EString(_)
            | Data::ESuper(_)
            | Data::EThis(_)
            | Data::EUndefined(_) => {}
        }
    }
}
