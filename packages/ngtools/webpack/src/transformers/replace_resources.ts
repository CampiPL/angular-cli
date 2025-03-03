/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ts from 'typescript';

export function replaceResources(
  shouldTransform: (fileName: string) => boolean,
  getTypeChecker: () => ts.TypeChecker,
  directTemplateLoading = false,
  inlineStyleMimeType?: string,
): ts.TransformerFactory<ts.SourceFile> {
  if (inlineStyleMimeType && !/^text\/[-.\w]+$/.test(inlineStyleMimeType)) {
    throw new Error('Invalid inline style MIME type.');
  }

  return (context: ts.TransformationContext) => {
    const typeChecker = getTypeChecker();
    const resourceImportDeclarations: ts.ImportDeclaration[] = [];
    const moduleKind = context.getCompilerOptions().module;
    const nodeFactory = context.factory;

    const visitNode: ts.Visitor = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        const decorators = ts.visitNodes(node.decorators, (node) =>
          ts.isDecorator(node)
            ? visitDecorator(
                nodeFactory,
                node,
                typeChecker,
                directTemplateLoading,
                resourceImportDeclarations,
                moduleKind,
                inlineStyleMimeType,
              )
            : node,
        );

        return nodeFactory.updateClassDeclaration(
          node,
          decorators,
          node.modifiers,
          node.name,
          node.typeParameters,
          node.heritageClauses,
          node.members,
        );
      }

      return ts.visitEachChild(node, visitNode, context);
    };

    return (sourceFile: ts.SourceFile) => {
      if (!shouldTransform(sourceFile.fileName)) {
        return sourceFile;
      }

      const updatedSourceFile = ts.visitNode(sourceFile, visitNode);
      if (resourceImportDeclarations.length) {
        // Add resource imports
        return context.factory.updateSourceFile(
          updatedSourceFile,
          ts.setTextRange(
            context.factory.createNodeArray([
              ...resourceImportDeclarations,
              ...updatedSourceFile.statements,
            ]),
            updatedSourceFile.statements,
          ),
        );
      }

      return updatedSourceFile;
    };
  };
}

function visitDecorator(
  nodeFactory: ts.NodeFactory,
  node: ts.Decorator,
  typeChecker: ts.TypeChecker,
  directTemplateLoading: boolean,
  resourceImportDeclarations: ts.ImportDeclaration[],
  moduleKind?: ts.ModuleKind,
  inlineStyleMimeType?: string,
): ts.Decorator {
  if (!isComponentDecorator(node, typeChecker)) {
    return node;
  }

  if (!ts.isCallExpression(node.expression)) {
    return node;
  }

  const decoratorFactory = node.expression;
  const args = decoratorFactory.arguments;
  if (args.length !== 1 || !ts.isObjectLiteralExpression(args[0])) {
    // Unsupported component metadata
    return node;
  }

  const objectExpression = args[0] as ts.ObjectLiteralExpression;
  const styleReplacements: ts.Expression[] = [];

  // visit all properties
  let properties = ts.visitNodes(objectExpression.properties, (node) =>
    ts.isObjectLiteralElementLike(node)
      ? visitComponentMetadata(
          nodeFactory,
          node,
          styleReplacements,
          directTemplateLoading,
          resourceImportDeclarations,
          moduleKind,
          inlineStyleMimeType,
        )
      : node,
  );

  // replace properties with updated properties
  if (styleReplacements.length > 0) {
    const styleProperty = nodeFactory.createPropertyAssignment(
      nodeFactory.createIdentifier('styles'),
      nodeFactory.createArrayLiteralExpression(styleReplacements),
    );

    properties = nodeFactory.createNodeArray([...properties, styleProperty]);
  }

  return nodeFactory.updateDecorator(
    node,
    nodeFactory.updateCallExpression(decoratorFactory, decoratorFactory.expression, decoratorFactory.typeArguments, [
      nodeFactory.updateObjectLiteralExpression(objectExpression, properties),
    ]),
  );
}

function visitComponentMetadata(
  nodeFactory: ts.NodeFactory,
  node: ts.ObjectLiteralElementLike,
  styleReplacements: ts.Expression[],
  directTemplateLoading: boolean,
  resourceImportDeclarations: ts.ImportDeclaration[],
  moduleKind?: ts.ModuleKind,
  inlineStyleMimeType?: string,
): ts.ObjectLiteralElementLike | undefined {
  if (!ts.isPropertyAssignment(node) || ts.isComputedPropertyName(node.name)) {
    return node;
  }

  const name = node.name.text;
  switch (name) {
    case 'moduleId':
      return undefined;

    case 'templateUrl':
      const url = getResourceUrl(node.initializer, directTemplateLoading ? '!raw-loader!' : '');
      if (!url) {
        return node;
      }

      const importName = createResourceImport(
        nodeFactory,
        url,
        resourceImportDeclarations,
        moduleKind,
      );
      if (!importName) {
        return node;
      }

      return nodeFactory.updatePropertyAssignment(
        node,
        nodeFactory.createIdentifier('template'),
        importName,
      );
    case 'styles':
    case 'styleUrls':
      if (!ts.isArrayLiteralExpression(node.initializer)) {
        return node;
      }

      const isInlineStyle = name === 'styles';
      const styles = ts.visitNodes(node.initializer.elements, node => {
        if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
          return node;
        }

        let url;
        if (isInlineStyle) {
          if (inlineStyleMimeType) {
            const data = Buffer.from(node.text).toString('base64');
            url = `data:${inlineStyleMimeType};charset=utf-8;base64,${data}`;
          } else {
            return nodeFactory.createStringLiteral(node.text);
          }
        } else {
          url = getResourceUrl(node);
        }

        if (!url) {
          return node;
        }

        return createResourceImport(nodeFactory, url, resourceImportDeclarations, moduleKind);
      });

      // Styles should be placed first
      if (isInlineStyle) {
        styleReplacements.unshift(...styles);
      } else {
        styleReplacements.push(...styles);
      }

      return undefined;
    default:
      return node;
  }
}

export function getResourceUrl(node: ts.Node, loader = ''): string | null {
  // only analyze strings
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
    return null;
  }

  return `${loader}${/^\.?\.\//.test(node.text) ? '' : './'}${node.text}`;
}

function isComponentDecorator(node: ts.Node, typeChecker: ts.TypeChecker): node is ts.Decorator {
  if (!ts.isDecorator(node)) {
    return false;
  }

  const origin = getDecoratorOrigin(node, typeChecker);
  if (origin && origin.module === '@angular/core' && origin.name === 'Component') {
    return true;
  }

  return false;
}

function createResourceImport(
  nodeFactory: ts.NodeFactory,
  url: string,
  resourceImportDeclarations: ts.ImportDeclaration[],
  moduleKind = ts.ModuleKind.ES2015,
): ts.Identifier | ts.Expression {
  const urlLiteral = nodeFactory.createStringLiteral(url);

  if (moduleKind < ts.ModuleKind.ES2015) {
    return nodeFactory.createPropertyAccessExpression(
      nodeFactory.createCallExpression(
        nodeFactory.createIdentifier('require'),
        [],
        [urlLiteral],
      ),
      'default',
    );
  } else {
    const importName = nodeFactory.createIdentifier(`__NG_CLI_RESOURCE__${resourceImportDeclarations.length}`);
    resourceImportDeclarations.push(nodeFactory.createImportDeclaration(
      undefined,
      undefined,
      nodeFactory.createImportClause(false, importName, undefined),
      urlLiteral,
    ));

    return importName;
  }
}

interface DecoratorOrigin {
  name: string;
  module: string;
}

function getDecoratorOrigin(
  decorator: ts.Decorator,
  typeChecker: ts.TypeChecker,
): DecoratorOrigin | null {
  if (!ts.isCallExpression(decorator.expression)) {
    return null;
  }

  let identifier: ts.Node;
  let name = '';

  if (ts.isPropertyAccessExpression(decorator.expression.expression)) {
    identifier = decorator.expression.expression.expression;
    name = decorator.expression.expression.name.text;
  } else if (ts.isIdentifier(decorator.expression.expression)) {
    identifier = decorator.expression.expression;
  } else {
    return null;
  }

  // NOTE: resolver.getReferencedImportDeclaration would work as well but is internal
  const symbol = typeChecker.getSymbolAtLocation(identifier);
  if (symbol && symbol.declarations && symbol.declarations.length > 0) {
    const declaration = symbol.declarations[0];
    let module: string;

    if (ts.isImportSpecifier(declaration)) {
      name = (declaration.propertyName || declaration.name).text;
      module = (declaration.parent.parent.parent.moduleSpecifier as ts.Identifier).text;
    } else if (ts.isNamespaceImport(declaration)) {
      // Use the name from the decorator namespace property access
      module = (declaration.parent.parent.moduleSpecifier as ts.Identifier).text;
    } else if (ts.isImportClause(declaration)) {
      name = (declaration.name as ts.Identifier).text;
      module = (declaration.parent.moduleSpecifier as ts.Identifier).text;
    } else {
      return null;
    }

    return { name, module };
  }

  return null;
}

export function workaroundStylePreprocessing(sourceFile: ts.SourceFile): void {
  const visitNode: ts.Visitor = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.decorators?.length) {
      for (const decorator of node.decorators) {
        visitDecoratorWorkaround(decorator);
      }
    }

    return ts.forEachChild(node, visitNode);
  };

  ts.forEachChild(sourceFile, visitNode);
}

function visitDecoratorWorkaround(node: ts.Decorator): void {
  if (!ts.isCallExpression(node.expression)) {
    return;
  }

  const decoratorFactory = node.expression;
  if (
    !ts.isIdentifier(decoratorFactory.expression) ||
    decoratorFactory.expression.text !== 'Component'
  ) {
    return;
  }

  const args = decoratorFactory.arguments;
  if (args.length !== 1 || !ts.isObjectLiteralExpression(args[0])) {
    // Unsupported component metadata
    return;
  }

  const objectExpression = args[0] as ts.ObjectLiteralExpression;

  // check if a `styles` property is present
  let hasStyles = false;
  for (const element of objectExpression.properties) {
    if (!ts.isPropertyAssignment(element) || ts.isComputedPropertyName(element.name)) {
      continue;
    }

    if (element.name.text === 'styles') {
      hasStyles = true;
      break;
    }
  }

  if (hasStyles) {
    return;
  }

  const nodeFactory = ts.factory;

  // add a `styles` property to workaround upstream compiler defect
  const emptyArray = nodeFactory.createArrayLiteralExpression();
  const stylePropertyName = nodeFactory.createIdentifier('styles');
  const styleProperty = nodeFactory.createPropertyAssignment(stylePropertyName, emptyArray);
  // tslint:disable-next-line: no-any
  (stylePropertyName.parent as any) = styleProperty;
  // tslint:disable-next-line: no-any
  (emptyArray.parent as any) = styleProperty;
  // tslint:disable-next-line: no-any
  (styleProperty.parent as any) = objectExpression;

  // tslint:disable-next-line: no-any
  (objectExpression.properties as any) = nodeFactory.createNodeArray([
    ...objectExpression.properties,
    styleProperty,
  ]);
}
