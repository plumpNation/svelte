import readExpression from '../read/expression.js';
import readScript from '../read/script.js';
import readStyle from '../read/style.js';
import { readEventHandlerDirective, readBindingDirective } from '../read/directives.js';
import { trimStart, trimEnd } from '../../utils/trim.js';
import { decodeCharacterReferences } from '../utils/html.js';
import isVoidElementName from '../../utils/isVoidElementName.js';

const validTagName = /^\!?[a-zA-Z]{1,}:?[a-zA-Z0-9\-]*/;
const invalidUnquotedAttributeCharacters = /[\s"'=<>\/`]/;

const SELF = ':Self';

const metaTags = {
	':Window': true
};

const specials = new Map( [
	[ 'script', {
		read: readScript,
		property: 'js'
	} ],
	[ 'style', {
		read: readStyle,
		property: 'css'
	} ]
] );

// based on http://developers.whatwg.org/syntax.html#syntax-tag-omission
const disallowedContents = new Map( [
	[ 'li', new Set( [ 'li' ] ) ],
	[ 'dt', new Set( [ 'dt', 'dd' ] ) ],
	[ 'dd', new Set( [ 'dt', 'dd' ] ) ],
	[ 'p', new Set( 'address article aside blockquote div dl fieldset footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split( ' ' ) ) ],
	[ 'rt', new Set( [ 'rt', 'rp' ] ) ],
	[ 'rp', new Set( [ 'rt', 'rp' ] ) ],
	[ 'optgroup', new Set( [ 'optgroup' ] ) ],
	[ 'option', new Set( [ 'option', 'optgroup' ] ) ],
	[ 'thead', new Set( [ 'tbody', 'tfoot' ] ) ],
	[ 'tbody', new Set( [ 'tbody', 'tfoot' ] ) ],
	[ 'tfoot', new Set( [ 'tbody' ] ) ],
	[ 'tr', new Set( [ 'tr', 'tbody' ] ) ],
	[ 'td', new Set( [ 'td', 'th', 'tr' ] ) ],
	[ 'th', new Set( [ 'td', 'th', 'tr' ] ) ],
] );

function stripWhitespace ( element ) {
	if ( element.children.length ) {
		const firstChild = element.children[0];
		const lastChild = element.children[ element.children.length - 1 ];

		if ( firstChild.type === 'Text' ) {
			firstChild.data = trimStart( firstChild.data );
			if ( !firstChild.data ) element.children.shift();
		}

		if ( lastChild.type === 'Text' ) {
			lastChild.data = trimEnd( lastChild.data );
			if ( !lastChild.data ) element.children.pop();
		}
	}
}

export default function tag ( parser ) {
	const start = parser.index++;

	let parent = parser.current();

	if ( parser.eat( '!--' ) ) {
		const data = parser.readUntil( /-->/ );
		parser.eat( '-->' );

		parser.current().children.push({
			start,
			end: parser.index,
			type: 'Comment',
			data
		});

		return null;
	}

	const isClosingTag = parser.eat( '/' );

	const name = readTagName( parser );

	if ( name in metaTags ) {
		if ( name in parser.metaTags ) {
			if ( isClosingTag && parser.current().children.length ) {
				parser.error( `<${name}> cannot have children`, parser.current().children[0].start );
			}

			parser.error( `A component can only have one <${name}> tag`, start );
		}

		parser.metaTags[ name ] = true;

		if ( parser.stack.length > 1 ) {
			parser.error( `<${name}> tags cannot be inside elements or blocks`, start );
		}
	}

	parser.allowWhitespace();

	if ( isClosingTag ) {
		if ( isVoidElementName( name ) ) {
			parser.error( `<${name}> is a void element and cannot have children, or a closing tag`, start );
		}

		if ( !parser.eat( '>' ) ) parser.error( `Expected '>'` );

		// close any elements that don't have their own closing tags, e.g. <div><p></div>
		while ( parent.name !== name ) {
			if ( parent.type !== 'Element' ) parser.error( `</${name}> attempted to close an element that was not open`, start );

			parent.end = start;
			parser.stack.pop();

			parent = parser.current();
		}

		// strip leading/trailing whitespace as necessary
		stripWhitespace( parent );

		parent.end = parser.index;
		parser.stack.pop();

		return null;
	} else if ( disallowedContents.has( parent.name ) ) {
		// can this be a child of the parent element, or does it implicitly
		// close it, like `<li>one<li>two`?
		if ( disallowedContents.get( parent.name ).has( name ) ) {
			stripWhitespace( parent );

			parent.end = start;
			parser.stack.pop();
		}
	}

	const attributes = [];
	const uniqueNames = new Set();

	let attribute;
	while ( attribute = readAttribute( parser, uniqueNames ) ) {
		attributes.push( attribute );
		parser.allowWhitespace();
	}

	parser.allowWhitespace();

	// special cases – top-level <script> and <style>
	if ( specials.has( name ) && parser.stack.length === 1 ) {
		const special = specials.get( name );

		if ( parser[ special.property ] ) {
			parser.index = start;
			parser.error( `You can only have one top-level <${name}> tag per component` );
		}

		parser.eat( '>', true );
		parser[ special.property ] = special.read( parser, start, attributes );
		return;
	}

	const element = {
		start,
		end: null, // filled in later
		type: 'Element',
		name,
		attributes,
		children: []
	};

	parser.current().children.push( element );

	const selfClosing = parser.eat( '/' ) || isVoidElementName( name );

	parser.eat( '>', true );

	if ( selfClosing ) {
		element.end = parser.index;
	} else {
		// don't push self-closing elements onto the stack
		parser.stack.push( element );
	}

	return null;
}

function readTagName ( parser ) {
	const start = parser.index;

	if ( parser.eat( SELF ) ) {
		// check we're inside a block, otherwise this
		// will cause infinite recursion
		let i = parser.stack.length;
		let legal = false;

		while ( i-- ) {
			const fragment = parser.stack[i];
			if ( fragment.type === 'IfBlock' || fragment.type === 'EachBlock' ) {
				legal = true;
				break;
			}
		}

		if ( !legal ) {
			parser.error( `<${SELF}> components can only exist inside if-blocks or each-blocks`, start );
		}

		return SELF;
	}

	const name = parser.readUntil( /(\s|\/|>)/ );

	if ( name in metaTags ) return name;

	if ( !validTagName.test( name ) ) {
		parser.error( `Expected valid tag name`, start );
	}

	return name;
}

function readAttribute ( parser, uniqueNames ) {
	const start = parser.index;

	let name = parser.readUntil( /(\s|=|\/|>)/ );
	if ( !name ) return null;
	if ( uniqueNames.has( name ) ) {
		parser.error( 'Attributes need to be unique', start );
	}

	uniqueNames.add( name );

	parser.allowWhitespace();

	if ( /^on:/.test( name ) ) {
		parser.eat( '=', true );
		return readEventHandlerDirective( parser, start, name.slice( 3 ) );
	}

	if ( /^bind:/.test( name ) ) {
		return readBindingDirective( parser, start, name.slice( 5 ) );
	}

	if ( /^ref:/.test( name ) ) {
		return {
			start,
			end: parser.index,
			type: 'Ref',
			name: name.slice( 4 )
		};
	}

	let value;

	// :foo is shorthand for foo='{{foo}}'
	if ( /^:\w+$/.test( name ) ) {
		name = name.slice( 1 );
		value = getShorthandValue( start + 1, name );
	} else {
		value = parser.eat( '=' ) ? readAttributeValue( parser ) : true;
	}

	return {
		start,
		end: parser.index,
		type: 'Attribute',
		name,
		value
	};
}

function readAttributeValue ( parser ) {
	let quoteMark;

	if ( parser.eat( `'` ) ) quoteMark = `'`;
	if ( parser.eat( `"` ) ) quoteMark = `"`;

	let currentChunk = {
		start: parser.index,
		end: null,
		type: 'Text',
		data: ''
	};

	const done = quoteMark ?
		char => char === quoteMark :
		char => invalidUnquotedAttributeCharacters.test( char );

	const chunks = [];

	while ( parser.index < parser.template.length ) {
		const index = parser.index;

		if ( parser.eat( '{{' ) ) {
			if ( currentChunk.data ) {
				currentChunk.end = index;
				chunks.push( currentChunk );
			}

			const expression = readExpression( parser );
			parser.allowWhitespace();
			if ( !parser.eat( '}}' ) ) {
				parser.error( `Expected }}` );
			}

			chunks.push({
				start: index,
				end: parser.index,
				type: 'MustacheTag',
				expression
			});

			currentChunk = {
				start: parser.index,
				end: null,
				type: 'Text',
				data: ''
			};
		}

		else if ( done( parser.template[ parser.index ] ) ) {
			currentChunk.end = parser.index;
			if ( quoteMark ) parser.index += 1;

			if ( currentChunk.data ) chunks.push( currentChunk );

			chunks.forEach( chunk => {
				if ( chunk.type === 'Text' ) chunk.data = decodeCharacterReferences( chunk.data );
			});

			return chunks;
		}

		else {
			currentChunk.data += parser.template[ parser.index++ ];
		}
	}

	parser.error( `Unexpected end of input` );
}

function getShorthandValue ( start, name ) {
	const end = start + name.length;

	return [{
		type: 'AttributeShorthand',
		start,
		end,
		expression: {
			type: 'Identifier',
			start,
			end,
			name
		}
	}];
}
