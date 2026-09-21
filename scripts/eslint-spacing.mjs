function declaration(node) {
  return node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
    ? (node.declaration ?? node)
    : node;
}

function needsSeparation(node) {
  node = declaration(node);

  return (
    [
      'FunctionDeclaration',
      'ClassDeclaration',
      'TSInterfaceDeclaration',
      'TSTypeAliasDeclaration',
      'TSEnumDeclaration',
      'MethodDefinition',
    ].includes(node.type) ||
    (node.type === 'VariableDeclaration' &&
      node.declarations.some((entry) =>
        ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(
          entry.init?.type,
        ),
      ))
  );
}

export default {
  rules: {
    'declaration-spacing': {
      meta: {
        type: 'layout',
        fixable: 'whitespace',
        schema: [],
        messages: { missing: 'Add a blank line between declarations or after imports.' },
      },
      create(context) {
        const source = context.sourceCode;

        function check(nodes) {
          for (let index = 1; index < nodes.length; index++) {
            const previous = nodes[index - 1];
            const current = nodes[index];
            const afterImports =
              previous.type === 'ImportDeclaration' && current.type !== 'ImportDeclaration';

            if (!afterImports && !needsSeparation(previous) && !needsSeparation(current)) continue;

            const comments = source
              .getCommentsBefore(current)
              .filter((comment) => comment.loc.start.line > previous.loc.end.line);
            const first = comments[0] ?? current;

            if (first.loc.start.line > previous.loc.end.line + 1) continue;

            context.report({
              node: current,
              messageId: 'missing',
              fix(fixer) {
                const gap = source.text.slice(previous.range[1], first.range[0]);

                // Preserve inline comments on the preceding declaration.
                const newline = gap.indexOf('\n');
                const position = newline < 0 ? first.range[0] : previous.range[1] + newline + 1;

                return fixer.insertTextBeforeRange(
                  [position, position],
                  newline < 0 ? '\n\n' : '\n',
                );
              },
            });
          }
        }

        return {
          Program: (node) => check(node.body),
          BlockStatement: (node) => check(node.body),
          ClassBody: (node) => check(node.body),
          SwitchCase: (node) => check(node.consequent),
          TSModuleBlock: (node) => check(node.body),
        };
      },
    },
  },
};
